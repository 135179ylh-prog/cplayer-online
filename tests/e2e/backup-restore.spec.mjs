import { test, expect } from '@playwright/test';
import { waitForAppReady, readUserPlaylists, openLibrary } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

// Build a valid backup payload with the given playlists array.
function backupFile(playlists) {
    return {
        name: 'cplayer-playlists-2026-07-21.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
            format: 'cplayer-playlists-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            playlists
        }), 'utf-8')
    };
}

const VALID_SONG = {
    id: 700001,
    name: '导入测试歌曲',
    artist: '导入歌手',
    cover: '',
    album: '导入专辑',
    source: 'Backup'
};

// P0: a valid backup import is additive and lands in IndexedDB as new user
// playlists without touching the queue.
test('valid backup import adds user playlists to storage', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    expect(await readUserPlaylists(page)).toHaveLength(0);

    await openLibrary(page);
    await page.locator('#playlistBackupInput').setInputFiles(
        backupFile([{ name: '备份歌单甲', songs: [VALID_SONG] }])
    );

    await expect(page.locator('#copyToast span')).toContainText('已导入 1 个歌单');
    const stored = await readUserPlaylists(page);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('备份歌单甲');
    expect(stored[0].songs).toHaveLength(1);
    expect(stored[0].songs[0].id).toBe(VALID_SONG.id);
    // id must be a freshly minted user_pl_ id, not a copied queue id.
    expect(String(stored[0].id)).toMatch(/^user_pl_/);
});

// P0: an invalid backup file must be rejected atomically — existing user
// playlists survive intact and no partial import is written.
test('invalid backup import preserves existing playlists (atomic rollback)', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    // Seed one existing playlist through a valid import first.
    await openLibrary(page);
    await page.locator('#playlistBackupInput').setInputFiles(
        backupFile([{ name: '现有歌单', songs: [VALID_SONG] }])
    );
    await expect(page.locator('#copyToast span')).toContainText('已导入 1 个歌单');
    const before = await readUserPlaylists(page);
    expect(before).toHaveLength(1);

    // Attempt a structurally invalid import: wrong format marker.
    await page.locator('#playlistBackupInput').setInputFiles({
        name: 'broken.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'not-a-cplayer-backup', version: 1 }), 'utf-8')
    });
    await expect(page.locator('#copyToast span')).toContainText('不是 CPlayer 歌单备份');

    // Existing data is untouched: same count, same name, same songs.
    const after = await readUserPlaylists(page);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('现有歌单');
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].songs).toHaveLength(1);
});

// P0 supporting case: a malformed-JSON file is rejected the same way.
test('malformed JSON backup is rejected without data loss', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    await openLibrary(page);
    await page.locator('#playlistBackupInput').setInputFiles(
        backupFile([{ name: '保底歌单', songs: [VALID_SONG] }])
    );
    await expect(page.locator('#copyToast span')).toContainText('已导入 1 个歌单');

    await page.locator('#playlistBackupInput').setInputFiles({
        name: 'garbage.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{ this is not valid json', 'utf-8')
    });
    await expect(page.locator('#copyToast span')).toContainText('不是有效的 JSON 文件');

    const after = await readUserPlaylists(page);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('保底歌单');
});
