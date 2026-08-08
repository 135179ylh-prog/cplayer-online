import { test, expect } from '@playwright/test';
import { waitForAppReady } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

// Splitting js/app.js into modules must not change what the app publishes on
// window. Losing one assignment during a move does not throw at load time; it
// surfaces much later as a dead button. This spec pins the whole surface so any
// omission fails immediately, at the step that caused it.
const REQUIRED_GLOBALS = [
    ['LOCAL_PLAYLIST', 'object'],
    ['addSongToQueueOnly', 'function'],
    ['bindUserPlaylistUI', 'function'],
    ['clearCPlayerPlaybackDiagnostics', 'function'],
    ['closeAddToPlaylistModal', 'function'],
    ['closeMyPlaylists', 'function'],
    ['closePlaylistDetail', 'function'],
    ['cyclePlayMode', 'function'],
    ['getCPlayerPlaybackDiagnostics', 'function'],
    ['getCachedImage', 'function'],
    ['getCloudHealthReport', 'function'],
    ['insertSongToPlaylist', 'function'],
    ['mobileUI', 'object'],
    ['openAddToPlaylistModal', 'function'],
    ['openMyPlaylists', 'function'],
    ['openPlaylistDetail', 'function'],
    ['playSongAtIndex', 'function'],
    ['playlist', 'object'],
    ['refreshMyPlaylists', 'function'],
    ['refreshPlaylistDetailList', 'function'],
    ['refreshPlaylistTrash', 'function'],
    ['refreshRecentHistory', 'function'],
    ['removeSongFromQueue', 'function'],
    ['runCloudHealthCheck', 'function'],
    ['setPlayMode', 'function'],
    ['updatePlayModeUI', 'function']
];

test('the app publishes its full global surface after a module split', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    const actual = await page.evaluate((names) => {
        const result = {};
        for (const name of names) result[name] = typeof window[name];
        return result;
    }, REQUIRED_GLOBALS.map(([name]) => name));

    const missing = REQUIRED_GLOBALS
        .filter(([name, kind]) => actual[name] !== kind)
        .map(([name, kind]) => `${name}: expected ${kind}, got ${actual[name]}`);
    expect(missing, `global surface changed:\n${missing.join('\n')}`).toEqual([]);
});

test('module-level playback state stays single-sourced across the split', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    // window.playlist must be the same array the queue APIs mutate, not a copy.
    // Two competing copies is the classic failure mode when state moves into a
    // module, and it is invisible until a later read returns stale data.
    // The first insert into an empty queue takes a separate push path, so seed
    // one song first and then measure identity across the real splice path.
    const identity = await page.evaluate(() => {
        const seeded = window.insertSongToPlaylist({
            id: 970100,
            name: '模块拆分基线歌曲',
            artist: '检查歌手',
            cover: '',
            album: '',
            source: 'module-surface-test'
        });
        const before = window.playlist;
        const beforeLength = before.length;
        const added = window.insertSongToPlaylist({
            id: 970101,
            name: '模块拆分状态检查',
            artist: '检查歌手',
            cover: '',
            album: '',
            source: 'module-surface-test'
        });
        const sameReference = window.playlist === before;
        const reflectsAdd = window.playlist.some((song) => song.id === 970101);
        // The array the app handed out earlier must itself have grown.
        const publishedArrayGrew = before.length === beforeLength + 1;
        for (const id of [970101, 970100]) {
            const index = window.playlist.findIndex((song) => song.id === id);
            if (index >= 0) window.removeSongFromQueue(index, { toast: false });
        }
        return {
            seededIndex: seeded,
            addedIndex: added,
            sameReference,
            reflectsAdd,
            publishedArrayGrew,
            cleanedUp: !window.playlist.some((song) => song.id === 970101 || song.id === 970100)
        };
    });

    expect(identity.reflectsAdd, 'the published playlist must reflect a queue insert').toBe(true);
    expect(identity.publishedArrayGrew, 'the already-published array must itself grow, not be swapped for a copy').toBe(true);
    expect(identity.sameReference, 'the published playlist must not be replaced by a copy').toBe(true);
    expect(identity.cleanedUp, 'the test songs must be removed again').toBe(true);
});
