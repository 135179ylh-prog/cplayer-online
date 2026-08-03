import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { waitForAppReady, openLibrary } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

const SONG = {
    id: 812001,
    name: '恢复包测试歌曲',
    artist: '恢复包测试歌手',
    cover: '',
    album: '恢复包测试专辑',
    source: 'Recovery'
};

async function readRecoveryStorage(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 6);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(['playlists', 'playlist_versions', 'cloud_outbox'], 'readonly');
            const playlists = tx.objectStore('playlists').getAll();
            const history = tx.objectStore('playlist_versions').getAll();
            const outbox = tx.objectStore('cloud_outbox').getAll();
            let result = { playlists: [], history: [], outbox: [] };
            playlists.onsuccess = () => { result.playlists = playlists.result || []; };
            history.onsuccess = () => { result.history = history.result || []; };
            outbox.onsuccess = () => { result.outbox = outbox.result || []; };
            tx.oncomplete = () => { db.close(); resolve(result); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        };
    }));
}

function recoveryFile(payload, name = 'cplayer-recovery.json') {
    return {
        name,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(payload), 'utf8')
    };
}

function recoveryPayload() {
    return {
        format: 'cplayer-recovery-package',
        version: 1,
        exportedAt: new Date().toISOString(),
        playlists: [
            { sourceId: 'user_pl_recovered_active', name: '恢复目标', songs: [SONG], deletedAt: 0 },
            { sourceId: 'user_pl_recovered_trash', name: '恢复回收站', songs: [], deletedAt: Date.now() }
        ],
        history: [{
            sourcePlaylistId: 'user_pl_recovered_active',
            name: '恢复目标',
            songs: [SONG],
            createdAt: Date.now() - 1000,
            reason: 'edit',
            snapshotId: 'snapshot-recovery-1'
        }]
    };
}

test('recovery package export includes active trash history but excludes sensitive fields', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await page.evaluate(async (song) => {
        await new Promise((resolve, reject) => {
            const open = indexedDB.open('CPlayer5DB', 6);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction(['playlists', 'playlist_versions', 'cloud_outbox'], 'readwrite');
                tx.objectStore('playlists').put({
                    id: 'user_pl_export_active', name: '导出活动', songs: [song], timestamp: Date.now(),
                    cloudOwnerId: 'owner-secret', cloudVersion: 7, cloudDirty: true, purgedAt: 0
                });
                tx.objectStore('playlists').put({
                    id: 'user_pl_export_trash', name: '导出回收站', songs: [], timestamp: Date.now(),
                    deletedAt: Date.now() - 1000, cloudOwnerId: 'owner-secret', cloudVersion: 8, cloudDirty: true, purgedAt: 0
                });
                tx.objectStore('playlist_versions').put({
                    id: 'history-export-1', playlistId: 'user_pl_export_active', name: '导出活动', songs: [song],
                    createdAt: Date.now() - 2000, reason: 'edit', snapshotId: 'snapshot-export-1', cloudOwnerId: 'owner-secret'
                });
                tx.objectStore('cloud_outbox').put({ id: 'owner-secret:user_pl_export_active', ownerId: 'owner-secret', playlistId: 'user_pl_export_active' });
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            };
        });
    }, SONG);

    await openLibrary(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出本机恢复包' }).click();
    const download = await downloadPromise;
    const payload = JSON.parse(await readFile(await download.path(), 'utf8'));
    expect(payload.format).toBe('cplayer-recovery-package');
    expect(payload.playlists).toHaveLength(2);
    expect(payload.history).toHaveLength(1);
    expect(payload.playlists.map((item) => item.name)).toEqual(expect.arrayContaining(['导出活动', '导出回收站']));
    const serialized = JSON.stringify(payload);
    for (const forbidden of ['owner-secret', 'cloudOwnerId', 'cloudVersion', 'cloudDirty', 'cloud_outbox', 'current_queue', 'cp_recent_history', 'cp_playback_session']) {
        expect(serialized).not.toContain(forbidden);
    }
});

test('recovery package import mints ids, maps history, preserves trash, and creates no outbox', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await openLibrary(page);
    await page.locator('#recoveryPackageInput').setInputFiles(recoveryFile(recoveryPayload()));
    await expect(page.locator('#copyToast span')).toContainText('已恢复 2 个歌单');

    const storage = await readRecoveryStorage(page);
    const imported = storage.playlists.filter((record) => String(record.id).startsWith('user_pl_'));
    expect(imported).toHaveLength(2);
    expect(imported.every((record) => !['user_pl_recovered_active', 'user_pl_recovered_trash'].includes(record.id))).toBe(true);
    const active = imported.find((record) => record.name.startsWith('恢复目标'));
    const trash = imported.find((record) => record.name.startsWith('恢复回收站'));
    expect(active).toBeTruthy();
    expect(trash.deletedAt).toBeGreaterThan(0);
    expect(active.cloudOwnerId).toBe('');
    expect(active.cloudVersion).toBe(0);
    expect(active.cloudDirty).toBe(false);
    expect(storage.history).toHaveLength(1);
    expect(storage.history[0].playlistId).toBe(active.id);
    expect(storage.history[0].snapshotId).toBe('snapshot-recovery-1');
    expect(storage.outbox).toHaveLength(0);
});

test('invalid recovery package fails before writing existing playlists', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await openLibrary(page);
    await page.locator('#recoveryPackageInput').setInputFiles(recoveryFile(recoveryPayload()));
    await expect(page.locator('#copyToast span')).toContainText('已恢复 2 个歌单');
    const before = await readRecoveryStorage(page);
    await page.locator('#recoveryPackageInput').setInputFiles(recoveryFile({ format: 'wrong', version: 1 }, 'broken.json'));
    await expect(page.locator('#copyToast span')).toContainText('不是 CPlayer 恢复包');
    const after = await readRecoveryStorage(page);
    expect(after.playlists).toEqual(before.playlists);
    expect(after.history).toEqual(before.history);
    expect(after.outbox).toEqual(before.outbox);
});
