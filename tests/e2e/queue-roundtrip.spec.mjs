import { test, expect } from '@playwright/test';
import {
    SEARCH_RESULT,
    openSearch,
    submitSearch,
    mockSearchSuccess,
    waitForAppReady,
    readQueueRecord
} from './helpers.mjs';

// Block the Service Worker so page.route controls the search boundary; the
// queue persistence under test is IndexedDB, which the SW does not touch.
test.use({ serviceWorkers: 'block' });

// P0: prove a searched song can be added to the play queue, that the add is
// persisted to IndexedDB, and that the queue survives a full page reload. The
// queue store is shared with playlists, so we assert on the current_queue
// record specifically.
test('queue add persists to IndexedDB and survives reload', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    mockSearchSuccess(page);

    await page.goto('/index.html');
    await waitForAppReady(page);

    // Baseline: no queue record and empty live queue before adding.
    expect(await readQueueRecord(page)).toBeNull();
    expect(await page.evaluate(() => window.playlist.length)).toBe(0);

    const search = await openSearch(page, projectName);
    await submitSearch(page, projectName, search.input);
    await expect(search.results.getByText(SEARCH_RESULT.name)).toBeVisible();

    // Add via the real UI button, not a synthetic API call.
    await search.results.getByRole('button', { name: '加入播放列表（不立即播放）' }).first().click();

    // Live state reflects the add immediately.
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(1);
    expect(await page.evaluate(() => window.playlist[0].id)).toBe(SEARCH_RESULT.id);

    // The debounced save (250ms) plus the dirty flag must land in storage.
    await expect.poll(async () => {
        const record = await readQueueRecord(page);
        return record ? record.songs.length : 0;
    }, { timeout: 5_000 }).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('cp_queue_dirty'))).toBe('1');

    // Reload with the same mock still installed; queue must restore from IndexedDB.
    await page.reload();
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(1);
    expect(await page.evaluate(() => window.playlist[0].id)).toBe(SEARCH_RESULT.id);
    expect(await page.evaluate(() => window.playlist[0].name)).toBe(SEARCH_RESULT.name);
});

// P0: removing the only queued song empties both the live queue and the
// persisted record, and the empty state survives reload (no stale restore).
test('queue removal clears storage and stays empty after reload', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    mockSearchSuccess(page);

    await page.goto('/index.html');
    await waitForAppReady(page);

    const search = await openSearch(page, projectName);
    await submitSearch(page, projectName, search.input);
    await expect(search.results.getByText(SEARCH_RESULT.name)).toBeVisible();
    await search.results.getByRole('button', { name: '加入播放列表（不立即播放）' }).first().click();
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(1);

    // Remove through the exposed queue API (virtualized rows are unreliable to click).
    await page.evaluate(() => window.removeSongFromQueue(0, { toast: false }));
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(0);

    await expect.poll(async () => {
        const record = await readQueueRecord(page);
        return record ? record.songs.length : 0;
    }, { timeout: 5_000 }).toBe(0);

    await page.reload();
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(0);
});
