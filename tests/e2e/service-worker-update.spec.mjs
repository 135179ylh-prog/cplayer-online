import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { readQueueRecord, waitForAppReady } from './helpers.mjs';

test.use({ serviceWorkers: 'allow' });

const swSource = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const cacheNameMatch = swSource.match(/const CACHE_NAME = '([^']+)'/);
if (!cacheNameMatch) throw new Error('Unable to read the current Service Worker cache name');

const CURRENT_CACHE_NAME = cacheNameMatch[1];
const OLD_CACHE_NAME = 'cplayer5-test-old';
const UNRELATED_CACHE_NAME = 'unrelated-test-cache';
const OLD_WORKER_PATH = '/tests/e2e/fixtures/sw-old.js';
const SEEDED_SONG = {
    id: 902201,
    name: '升级保留测试歌曲',
    artist: '本地测试歌手',
    cover: '',
    album: '本地测试专辑',
    source: 'update_test'
};
const SEEDED_RECENT = [{ ...SEEDED_SONG, playedAt: 1_784_710_000_000 }];

async function seedBrowserData(page) {
    await page.evaluate(async ({ song, recent }) => {
        localStorage.setItem('cp_queue_dirty', '1');
        localStorage.setItem('cp_recent_history', JSON.stringify(recent));
        localStorage.setItem('cp_playback_session', JSON.stringify({
            version: 1,
            songId: String(song.id),
            currentIndex: 0,
            currentTime: 42,
            duration: 240,
            wasPlaying: false,
            updatedAt: Date.now(),
            reason: 'update_test_seed'
        }));

        await new Promise((resolve, reject) => {
            const open = indexedDB.open('CPlayer5DB', 3);
            open.onupgradeneeded = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('playlists')) {
                    db.createObjectStore('playlists', { keyPath: 'id' });
                }
            };
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('playlists', 'readwrite');
                tx.objectStore('playlists').put({
                    id: 'current_queue',
                    songs: [song],
                    currentIndex: 0,
                    playMode: 'sequence',
                    timestamp: Date.now(),
                    reason: 'update_test_seed'
                });
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error); };
                tx.onabort = () => { db.close(); reject(tx.error); };
            };
        });

        const unrelated = await caches.open('unrelated-test-cache');
        await unrelated.put('/unrelated-marker', new Response('keep'));
    }, { song: SEEDED_SONG, recent: SEEDED_RECENT });
}

async function activateOldWorker(page) {
    await page.goto('/playlist-downloader.html');
    await seedBrowserData(page);
    await page.evaluate(async (workerPath) => {
        const registration = await navigator.serviceWorker.register(workerPath, {
            scope: '/',
            updateViaCache: 'none'
        });
        if (!registration.active || registration.active.state !== 'activated') {
            await new Promise((resolve, reject) => {
                const worker = registration.installing || registration.waiting || registration.active;
                if (!worker) {
                    reject(new Error('Old Worker did not enter an install state'));
                    return;
                }
                const onStateChange = () => {
                    if (worker.state === 'activated') resolve();
                    if (worker.state === 'redundant') reject(new Error('Old Worker became redundant'));
                };
                worker.addEventListener('statechange', onStateChange);
                onStateChange();
            });
        }
    }, OLD_WORKER_PATH);
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || ''))
        .toContain(OLD_WORKER_PATH);
}

async function openAppAndWaitForUpgrade(page) {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await expect(page.locator('#appUpdateBanner')).toBeVisible();
    await expect(page.locator('#appUpdateBanner')).toContainText('播放器已更新');
    expect(await page.evaluate(() => window.playlist.map((song) => song.id)))
        .toEqual([SEEDED_SONG.id]);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || ''))
        .toMatch(/\/sw\.js$/);
}

test('old installation upgrades, preserves data, and reloads offline', async ({ page, context }) => {
    await activateOldWorker(page);
    await openAppAndWaitForUpgrade(page);

    const cacheState = await page.evaluate(async (currentName) => {
        const names = await caches.keys();
        const currentUrls = names.includes(currentName)
            ? (await (await caches.open(currentName)).keys()).map((request) => new URL(request.url).pathname)
            : [];
        return { names, currentUrls };
    }, CURRENT_CACHE_NAME);
    expect(cacheState.names).toContain(CURRENT_CACHE_NAME);
    expect(cacheState.names).toContain(UNRELATED_CACHE_NAME);
    expect(cacheState.currentUrls).toContain('/index.html');
    expect(cacheState.currentUrls).toContain('/js/app.js');
    expect(cacheState.currentUrls.length).toBeGreaterThanOrEqual(11);
    await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain(OLD_CACHE_NAME);

    await context.setOffline(true);
    try {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.getByRole('button', { name: '刷新', exact: true }).click()
        ]);
        await waitForAppReady(page);
        await expect(page.locator('#buildBadge')).toHaveText(/^v\d+$/);
        await expect.poll(() => page.evaluate(() => window.playlist.map((song) => song.id)))
            .toEqual([SEEDED_SONG.id]);

        const queueRecord = await readQueueRecord(page);
        expect(queueRecord.songs.map((song) => song.id)).toEqual([SEEDED_SONG.id]);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cp_recent_history'))))
            .toEqual(SEEDED_RECENT);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cp_playback_session')).songId))
            .toBe(String(SEEDED_SONG.id));
    } finally {
        await context.setOffline(false);
    }
});

test('update prompt can be dismissed without reloading', async ({ page }) => {
    await activateOldWorker(page);
    await openAppAndWaitForUpgrade(page);
    const pageUrl = page.url();

    await page.getByRole('button', { name: '稍后刷新' }).click();
    await expect(page.locator('#appUpdateBanner')).toBeHidden();
    expect(page.url()).toBe(pageUrl);
    await expect(page.locator('#buildBadge')).toHaveText(/^v\d+$/);
});
