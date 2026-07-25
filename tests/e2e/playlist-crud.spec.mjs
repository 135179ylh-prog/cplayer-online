import { test, expect } from '@playwright/test';
import {
    waitForAppReady,
    readPlaylistVersions,
    readTrashPlaylists,
    readUserPlaylists,
    openLibrary
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

// P1: delete is recoverable, persists across reload, and restore returns the
// exact local record without requiring an account.
test('user playlist delete enters local trash and restores after reload', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    expect(await readUserPlaylists(page)).toHaveLength(0);

    await openLibrary(page);

    // Create through the real input + button.
    await page.locator('#myNewPlaylistName').fill('我的测试歌单');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect(page.locator('#copyToast span')).toContainText('歌单已创建');

    await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(1);
    const created = await readUserPlaylists(page);
    expect(created[0].name).toBe('我的测试歌单');
    expect(created[0].songs).toHaveLength(0);
    expect(String(created[0].id)).toMatch(/^user_pl_/);

    // The library list and count badge reflect the new playlist.
    await expect(page.locator('#libraryPlaylistCount')).toHaveText('1');
    await expect(page.locator('#myPlaylistsList').getByText('我的测试歌单')).toBeVisible();

    // Delete: accept the confirm dialog, then verify active + trash projections.
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除歌单「我的测试歌单」' }).click();

    await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(0);
    await expect.poll(async () => (await readTrashPlaylists(page)).length).toBe(1);
    await expect(page.locator('#libraryPlaylistCount')).toHaveText('0');
    await expect(page.locator('#myPlaylistsList')).toContainText('还没有自建歌单');

    await page.reload();
    await waitForAppReady(page);
    await openLibrary(page);
    await page.getByRole('tab', { name: /回收站/ }).click();
    await expect(page.locator('#playlistTrashList')).toContainText('我的测试歌单');
    await expect(page.locator('#playlistTrashList')).toContainText('剩余 30 天');
    await page.getByRole('button', { name: '恢复歌单「我的测试歌单」' }).click();
    await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(1);
    await expect.poll(async () => (await readTrashPlaylists(page)).length).toBe(0);
    expect((await readUserPlaylists(page))[0].name).toBe('我的测试歌单');
});

test('permanent delete clears a local trash item after explicit confirmation', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await openLibrary(page);
    await page.locator('#myNewPlaylistName').fill('永久删除测试');
    await page.locator('#myCreatePlaylistBtn').click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除歌单「永久删除测试」' }).click();
    await page.getByRole('tab', { name: /回收站/ }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '永久删除歌单「永久删除测试」' }).click();
    await expect.poll(async () => (await readTrashPlaylists(page)).length).toBe(0);
    await expect(page.locator('#playlistTrashList')).toContainText('回收站是空的');
});

test('trash older than 30 days is permanently cleaned on startup', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 6);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const database = open.result;
            const tx = database.transaction('playlists', 'readwrite');
            tx.objectStore('playlists').put({
                id: 'user_pl_expired_trash',
                name: '已过期歌单',
                songs: [],
                timestamp: Date.now() - 31 * 86_400_000,
                deletedAt: Date.now() - 31 * 86_400_000,
                purgedAt: 0,
                cloudOwnerId: '',
                cloudVersion: 0,
                cloudDirty: false
            });
            tx.oncomplete = () => { database.close(); resolve(); };
            tx.onerror = () => { database.close(); reject(tx.error); };
        };
    }));
    await page.reload();
    await waitForAppReady(page);
    expect(await readTrashPlaylists(page)).toEqual([]);
    expect(await readUserPlaylists(page)).toEqual([]);
    await openLibrary(page);
    await page.getByRole('tab', { name: /回收站/ }).click();
    await expect(page.locator('#playlistTrashList')).toContainText('回收站是空的');
});

test('history preview restores a version and keeps the pre-restore content', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await openLibrary(page);
    await page.locator('#myNewPlaylistName').fill('历史测试');
    await page.locator('#myCreatePlaylistBtn').click();
    const playlistId = (await readUserPlaylists(page))[0].id;

    const songs = [
        { id: 88001, name: '历史歌曲一', artist: '歌手一', album: '', cover: '', source: 'test' },
        { id: 88002, name: '历史歌曲二', artist: '歌手二', album: '', cover: '', source: 'test' }
    ];
    for (const [index, song] of songs.entries()) {
        await page.evaluate((value) => window.openAddToPlaylistModal(value), song);
        await page.getByRole('button', { name: /历史测试 \d+ 首 加入/ }).click();
        await expect.poll(async () => (await readUserPlaylists(page))[0].songs.length).toBe(index + 1);
        await expect(page.locator('#userPlaylistModal')).toBeHidden();
    }
    await expect.poll(async () => (await readUserPlaylists(page))[0].songs.length).toBe(2);
    await expect.poll(async () => (await readPlaylistVersions(page, playlistId)).length).toBe(2);

    await page.getByRole('button', { name: '管理歌单「历史测试」' }).click();
    await page.getByRole('button', { name: '历史版本' }).click();
    await expect(page.locator('#playlistHistoryModal')).toBeVisible();
    const versionButtons = page.locator('#playlistHistoryList button');
    await expect(versionButtons).toHaveCount(2);
    await versionButtons.last().click();
    await expect(page.locator('#playlistHistoryPreview')).toContainText('这个版本没有歌曲');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '恢复这个历史版本' }).click();
    await expect.poll(async () => (await readUserPlaylists(page))[0].songs.length).toBe(0);
    await expect.poll(async () => (await readPlaylistVersions(page, playlistId)).length).toBe(3);
});

// P1: dismissing the delete confirm dialog keeps the playlist intact.
test('dismissing delete confirm keeps the playlist', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    await openLibrary(page);
    await page.locator('#myNewPlaylistName').fill('保留歌单');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(1);

    // Dismiss the confirm dialog: the playlist must survive.
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: '删除歌单「保留歌单」' }).click();

    // Give the (cancelled) handler a beat, then confirm nothing was deleted.
    await page.waitForTimeout(200);
    const after = await readUserPlaylists(page);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('保留歌单');
});

// P1: creating with an empty name is rejected with feedback and no record.
test('empty playlist name is rejected', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    await openLibrary(page);
    await page.locator('#myNewPlaylistName').fill('   ');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect(page.locator('#copyToast span')).toContainText('请输入歌单名称');
    expect(await readUserPlaylists(page)).toHaveLength(0);
});
