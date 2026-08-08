import { test, expect } from '@playwright/test';
import { openSettings, waitForAppReady } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

const ALLOWED_ERRORS = [
    /播放列表加载失败/,
    /Failed to load resource: the server responded with a status of 503/,
    /\[playback\] .* failed/
];

// PlaylistService normalises ar/al and artists/album shapes (js/app.js:7841).
const PLAYLIST_SONGS = [
    { id: 960001, name: '歌单歌曲一', artists: [{ name: '歌单歌手' }], album: { name: '歌单专辑', picUrl: '' }, picUrl: '' },
    { id: 960002, name: '歌单歌曲二', artists: [{ name: '歌单歌手' }], album: { name: '歌单专辑', picUrl: '' }, picUrl: '' }
];

// Loading a remote playlist clears the queue before fetching. If the fetch then
// fails, the published window.playlist must not keep pointing at the songs that
// were just cleared: an observer would read a queue the app no longer has.
test('a failed playlist load leaves no stale published queue', async ({ page }) => {
    const errors = [];
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!ALLOWED_ERRORS.some((pattern) => pattern.test(text))) errors.push(text);
    });

    let failPlaylist = false;
    await page.route(/\/163_playlist\?/, async (route) => {
        if (failPlaylist) {
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ code: 503, message: 'injected playlist failure' })
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            // PlaylistService.fetchPlaylist reads data.tracks (js/app.js:7833).
            body: JSON.stringify({ code: 200, data: { tracks: PLAYLIST_SONGS, name: '测试歌单' } })
        });
    });
    await page.route(/\/163_music\?/, async (route) => {
        const id = new URL(route.request().url()).searchParams.get('id') || '';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: {
                    id: Number(id), name: 'x', artist: 'y', picUrl: '',
                    url: `https://media.example.test/${id}.mp3`, level: 'standard', br: 128000
                }
            })
        });
    });

    await page.goto('/index.html');
    await waitForAppReady(page);

    // Drive the real user path: the playlist-id field in settings. openSettings
    // resolves the entry by role, which differs between desktop and mobile layouts.
    const loadPlaylist = async (id) => {
        await openSettings(page);
        await page.locator('#playlistIdInput').fill(id);
        await page.locator('#loadPlaylistBtn').click();
    };

    await loadPlaylist('70011');
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(PLAYLIST_SONGS.length);

    // The second load clears the queue and then fails mid-flight.
    failPlaylist = true;
    await loadPlaylist('70022');
    await expect(page.locator('#copyToast span')).toContainText('播放列表加载失败');

    // The published queue must agree with the queue the app actually holds.
    const consistency = await page.evaluate(() => ({
        publishedLength: window.playlist.length,
        publishedIds: window.playlist.map((song) => song.id),
        renderedRows: document.querySelectorAll('#playlistContent .playlist-item').length
    }));
    expect(consistency.publishedLength,
        `window.playlist still exposes ${JSON.stringify(consistency.publishedIds)} after a failed load`)
        .toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
});
