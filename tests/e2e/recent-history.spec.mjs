import { test, expect } from '@playwright/test';
import { waitForAppReady, openLibrary } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

const RECENT_KEY = 'cp_recent_history';

// Build N synthetic recent-history entries (newest-first, as the app stores).
function makeEntries(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: 800000 + i,
        name: '历史歌曲 ' + i,
        artist: '历史歌手',
        cover: '',
        album: '',
        source: 'Backup',
        playedAt: Date.now() - i * 1000
    }));
}

async function openRecentTab(page) {
    await openLibrary(page);
    await page.locator('#libraryRecentTab').click();
    await expect(page.locator('#libraryRecentPanel')).toBeVisible();
}

// P1: the read/render path caps recent history at 50 entries even if storage
// somehow holds more, and the count badge reflects the capped length.
test('recent history render caps at 50 entries', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    // Seed 60 entries directly, then reload so the app reads them fresh.
    await page.evaluate(({ key, entries }) => {
        localStorage.setItem(key, JSON.stringify(entries));
    }, { key: RECENT_KEY, entries: makeEntries(60) });
    await page.reload();
    await waitForAppReady(page);

    await openRecentTab(page);
    await expect(page.locator('#libraryRecentCount')).toHaveText('50');
    await expect(page.locator('#recentHistoryList .music-library-recent-row')).toHaveCount(50);
    // Newest-first ordering is preserved: entry 0 renders, entry 59 is dropped.
    await expect(page.locator('#recentHistoryList')).toContainText('历史歌曲 0');
    await expect(page.locator('#recentHistoryList')).not.toContainText('历史歌曲 59');
});

// P1: entries without a valid id are dropped on read so corrupt storage cannot
// break the list or inflate the count.
test('recent history drops entries without a valid id', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    await page.evaluate(({ key }) => {
        localStorage.setItem(key, JSON.stringify([
            { id: 800001, name: '有效歌曲', artist: '甲', playedAt: Date.now() },
            { name: '无 id 歌曲', artist: '乙', playedAt: Date.now() },
            { id: '', name: '空 id 歌曲', artist: '丙', playedAt: Date.now() }
        ]));
    }, { key: RECENT_KEY });
    await page.reload();
    await waitForAppReady(page);

    await openRecentTab(page);
    await expect(page.locator('#libraryRecentCount')).toHaveText('1');
    await expect(page.locator('#recentHistoryList')).toContainText('有效歌曲');
    await expect(page.locator('#recentHistoryList')).not.toContainText('无 id 歌曲');
});

// P1: the clear control empties recent history and the storage key.
test('clearing recent history empties storage', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    await page.evaluate(({ key, entries }) => {
        localStorage.setItem(key, JSON.stringify(entries));
    }, { key: RECENT_KEY, entries: makeEntries(3) });
    await page.reload();
    await waitForAppReady(page);

    await openRecentTab(page);
    await expect(page.locator('#libraryRecentCount')).toHaveText('3');

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#clearRecentHistoryBtn').click();

    await expect(page.locator('#libraryRecentCount')).toHaveText('0');
    await expect(page.locator('#recentHistoryList')).toContainText('还没有最近播放');
    expect(await page.evaluate((key) => localStorage.getItem(key), RECENT_KEY)).toBeNull();
});
