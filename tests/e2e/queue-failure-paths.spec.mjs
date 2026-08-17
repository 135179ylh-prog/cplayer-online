import { test, expect } from '@playwright/test';
import {
    mockSearchSuccess,
    openSearch,
    submitSearch,
    waitForAppReady,
    collectUnexpectedErrors,
    installRuntimeProbes,
    readMainAudioProbe,
    readQueueRecord
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

// The skip path deliberately logs each failed attempt; allow only those lines so
// any other runtime error still fails the test.
const ALLOWED_PLAYBACK_ERRORS = [
    /\[playback\] .* failed/,
    /Song API returned no data/,
    /empty song payload/,
    /Failed to load resource: the server responded with a status of 503/
];

const QUEUE_SONGS = [
    { id: 940001, name: '队列歌曲一', artists: [{ name: '队列歌手' }], album: { name: '队列专辑', picUrl: '' }, picUrl: '' },
    { id: 940002, name: '队列歌曲二', artists: [{ name: '队列歌手' }], album: { name: '队列专辑', picUrl: '' }, picUrl: '' },
    { id: 940003, name: '队列歌曲三', artists: [{ name: '队列歌手' }], album: { name: '队列专辑', picUrl: '' }, picUrl: '' }
];

// Serve the song-detail endpoint, failing exactly the ids in failIds with a 503
// and returning a playable payload for every other id. Returns the request log
// so a test can prove which queue entries were actually attempted.
async function routeSongDetail(page, failIds) {
    const requestedIds = [];
    // Lyrics are fetched for every committed song. Left unmocked they reach the
    // real upstream, which answers 401 without a key, and that auth error
    // surfaces ahead of the skip toast this spec asserts on. CI has outbound
    // network access, so the omission failed there while passing locally.
    await page.route(/\/163_lyric\?/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { lrc: '', tlyric: '' } })
        });
    });
    await page.route(/\/163_music\?/, async (route) => {
        const id = new URL(route.request().url()).searchParams.get('id') || '';
        requestedIds.push(id);
        if (failIds.has(Number(id))) {
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ code: 503, message: 'injected song failure' })
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: {
                    id: Number(id),
                    name: `队列歌曲 ${id}`,
                    artist: '队列歌手',
                    url: `https://media.example.test/${id}.mp3`,
                    picUrl: '',
                    level: 'standard',
                    br: 128000
                }
            })
        });
    });
    return requestedIds;
}

// Seed the queue through the real add button and return the resulting id order.
// insertSongToPlaylist places each song after the current index rather than
// appending (js/app.js:8745-8756), so the queue order is deliberately read back
// from the app instead of assumed to match the search order.
async function seedQueue(page, projectName, songs) {
    const search = await openSearch(page, projectName);
    await submitSearch(page, projectName, search.input);
    for (const song of songs) {
        await expect(search.results.getByText(song.name, { exact: true })).toBeVisible();
    }
    const addButtons = search.results.getByRole('button', { name: '加入播放列表（不立即播放）' });
    await expect(addButtons).toHaveCount(songs.length);
    for (let index = 0; index < songs.length; index += 1) {
        await addButtons.nth(index).click();
        await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(index + 1);
    }
    return page.evaluate(() => window.playlist.map((song) => song.id));
}

// currentIndex is module-local and never exposed on window (js/app.js:286), so
// the playing position is read from the persisted queue record instead.
async function readPersistedIndex(page) {
    const record = await readQueueRecord(page);
    return record ? record.currentIndex : null;
}

// The queue's only self-healing path: a dead song must be skipped, the skip must
// land on the next playable entry, and the failed entry must not be retried.
test('a failing song is skipped and playback lands on the next queue entry', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    const errors = collectUnexpectedErrors(page, ALLOWED_PLAYBACK_ERRORS);
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    mockSearchSuccess(page, QUEUE_SONGS);
    const failingId = QUEUE_SONGS[0].id;
    const requestedIds = await routeSongDetail(page, new Set([failingId]));

    await page.goto('/index.html');
    await waitForAppReady(page);
    const queueIds = await seedQueue(page, projectName, QUEUE_SONGS);
    const failingIndex = queueIds.indexOf(failingId);
    const expectedNextId = queueIds[failingIndex + 1];
    expect(expectedNextId, 'the failing song must have a later entry to skip to').toBeDefined();

    await page.evaluate((index) => window.playSongAtIndex(index), failingIndex);

    // The user is told the app is moving on, not left with a silent dead song.
    await expect(page.locator('#copyToast span')).toContainText('正在尝试下一首');

    // The skip must commit the *next* song's media, not re-arm the failed one.
    await expect
        .poll(async () => (await readMainAudioProbe(page))?.src || '')
        .toContain(String(expectedNextId));

    // The skip loop must not come back to the dead song. The transport retries a
    // 5xx once on its own (API_REQUEST_RETRIES in js/core-utils.js), so the dead
    // id legitimately appears more than once; what matters is that every attempt
    // for it happens before the successful song is fetched.
    const failedAttempts = requestedIds.filter((id) => id === String(failingId));
    expect(failedAttempts.length).toBeGreaterThanOrEqual(1);
    expect(requestedIds).toContain(String(expectedNextId));
    expect(requestedIds.lastIndexOf(String(failingId)))
        .toBeLessThan(requestedIds.indexOf(String(expectedNextId)));

    // The playing position must move with the skip. If it stays on the dead song,
    // the highlighted row and every later next/previous act on the wrong entry.
    await expect.poll(async () => await readPersistedIndex(page)).toBe(failingIndex + 1);
    const skipRecord = await readQueueRecord(page);
    expect(skipRecord.songs[skipRecord.currentIndex].id).toBe(expectedNextId);

    // Skipping must not silently drop the failed song from the user's queue.
    expect(await page.evaluate(() => window.playlist.length)).toBe(QUEUE_SONGS.length);

    await page.waitForTimeout(500);
    expect(errors, errors.join('\n')).toEqual([]);
});

// Loop termination: when every entry fails, the app must stop after trying each
// one exactly once rather than cycling the queue forever.
test('an all-failing queue stops after trying each entry exactly once', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    const errors = collectUnexpectedErrors(page, ALLOWED_PLAYBACK_ERRORS);
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    mockSearchSuccess(page, QUEUE_SONGS);
    const requestedIds = await routeSongDetail(page, new Set(QUEUE_SONGS.map((song) => song.id)));

    await page.goto('/index.html');
    await waitForAppReady(page);
    const queueIds = await seedQueue(page, projectName, QUEUE_SONGS);
    expect(queueIds).toHaveLength(QUEUE_SONGS.length);

    await page.evaluate(() => window.playSongAtIndex(0));

    await expect(page.locator('#copyToast span')).toContainText('没有可播放歌曲');

    // Every entry is attempted, and each one is visited as a single contiguous
    // run of transport attempts. Re-walking the queue would interleave the ids,
    // so a contiguous grouping proves failedIndexes accumulates and the candidate
    // search terminates instead of cycling.
    for (const song of QUEUE_SONGS) {
        expect(requestedIds).toContain(String(song.id));
    }
    const visitOrder = requestedIds.filter((id, index) => id !== requestedIds[index - 1]);
    expect(visitOrder).toHaveLength(QUEUE_SONGS.length);
    expect(new Set(visitOrder).size).toBe(QUEUE_SONGS.length);

    // Give the loop a chance to misbehave before asserting it really stopped.
    const settled = requestedIds.length;
    await page.waitForTimeout(500);
    expect(requestedIds).toHaveLength(settled);

    const mainAudio = await readMainAudioProbe(page);
    expect(mainAudio.paused).toBe(true);
    expect(await page.evaluate(() => window.playlist.length)).toBe(QUEUE_SONGS.length);
    expect(errors, errors.join('\n')).toEqual([]);
});

// Removing the song that is playing must advance to the replacement at that
// index and persist a currentIndex that still points inside the queue.
test('removing the playing song advances to the replacement at that index', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    const errors = collectUnexpectedErrors(page, ALLOWED_PLAYBACK_ERRORS);
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    mockSearchSuccess(page, QUEUE_SONGS);
    await routeSongDetail(page, new Set());

    await page.goto('/index.html');
    await waitForAppReady(page);
    const queueIds = await seedQueue(page, projectName, QUEUE_SONGS);

    // Play the middle entry, then delete that same entry.
    const playingIndex = 1;
    const playingId = queueIds[playingIndex];
    const replacementId = queueIds[playingIndex + 1];
    await page.evaluate((index) => window.playSongAtIndex(index), playingIndex);
    await expect
        .poll(async () => (await readMainAudioProbe(page))?.src || '')
        .toContain(String(playingId));

    await page.evaluate((index) => window.removeSongFromQueue(index, { toast: false }), playingIndex);

    // That index now holds the following song, and that is what must play.
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(2);
    await expect
        .poll(async () => (await readMainAudioProbe(page))?.src || '')
        .toContain(String(replacementId));

    // A currentIndex past the end would resume on the wrong track after reload.
    await expect
        .poll(async () => (await readQueueRecord(page))?.songs?.length || 0)
        .toBe(2);
    const record = await readQueueRecord(page);
    expect(record.currentIndex).toBeLessThan(record.songs.length);
    expect(record.currentIndex).toBe(playingIndex);
    expect(record.songs.map((song) => song.id)).toEqual([queueIds[0], replacementId]);

    await page.waitForTimeout(500);
    expect(errors, errors.join('\n')).toEqual([]);
});

// Deleting the playing song when it is the LAST entry has no replacement at that
// index, so the pointer must be clamped back inside the queue. Without the clamp
// it points one past the end and a reload resumes on nothing.
test('removing the playing song at the end of the queue clamps the pointer', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    const errors = collectUnexpectedErrors(page, ALLOWED_PLAYBACK_ERRORS);
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    mockSearchSuccess(page, QUEUE_SONGS);
    await routeSongDetail(page, new Set());

    await page.goto('/index.html');
    await waitForAppReady(page);
    const queueIds = await seedQueue(page, projectName, QUEUE_SONGS);

    const lastIndex = queueIds.length - 1;
    await page.evaluate((index) => window.playSongAtIndex(index), lastIndex);
    await expect
        .poll(async () => (await readMainAudioProbe(page))?.src || '')
        .toContain(String(queueIds[lastIndex]));

    await page.evaluate((index) => window.removeSongFromQueue(index, { toast: false }), lastIndex);
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(2);

    // The pointer must land on the new last entry, never past the end.
    await expect.poll(async () => await readPersistedIndex(page)).toBe(1);
    const record = await readQueueRecord(page);
    expect(record.currentIndex).toBeLessThan(record.songs.length);
    expect(record.songs.map((song) => song.id)).toEqual(queueIds.slice(0, lastIndex));

    await page.waitForTimeout(500);
    expect(errors, errors.join('\n')).toEqual([]);
});

// Removing an entry before the playing one must keep the same track playing by
// decrementing currentIndex, not shift the pointer onto a different song.
test('removing a song before the playing one keeps the same track playing', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    const errors = collectUnexpectedErrors(page, ALLOWED_PLAYBACK_ERRORS);
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    mockSearchSuccess(page, QUEUE_SONGS);
    await routeSongDetail(page, new Set());

    await page.goto('/index.html');
    await waitForAppReady(page);
    const queueIds = await seedQueue(page, projectName, QUEUE_SONGS);

    // Play the last entry, then delete an entry positioned before it.
    const playingIndex = queueIds.length - 1;
    const playingId = queueIds[playingIndex];
    await page.evaluate((index) => window.playSongAtIndex(index), playingIndex);
    await expect
        .poll(async () => (await readMainAudioProbe(page))?.src || '')
        .toContain(String(playingId));
    const beforeRemoval = await readMainAudioProbe(page);

    await page.evaluate(() => window.removeSongFromQueue(0, { toast: false }));

    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(2);

    // The same media must still be loaded: no reload, no switch to another song.
    const afterRemoval = await readMainAudioProbe(page);
    expect(afterRemoval.src).toBe(beforeRemoval.src);
    expect(afterRemoval.src).toContain(String(playingId));
    expect(afterRemoval.loadCalls).toBe(beforeRemoval.loadCalls);

    // The pointer must follow the same song to its new position, not stay put.
    await expect.poll(async () => await readPersistedIndex(page)).toBe(playingIndex - 1);
    const record = await readQueueRecord(page);
    expect(record.songs.map((song) => song.id)).toEqual(queueIds.slice(1));
    expect(record.songs[record.currentIndex].id).toBe(playingId);

    await page.waitForTimeout(500);
    expect(errors, errors.join('\n')).toEqual([]);
});
