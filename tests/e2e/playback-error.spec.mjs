import { test, expect } from '@playwright/test';
import {
    SEARCH_RESULT,
    openSearch,
    submitSearch,
    mockSearchSuccess,
    waitForAppReady,
    collectUnexpectedErrors,
    installAudioProbe,
    readMainAudioProbe
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

// The app deliberately logs a playback failure via console.error; allow only
// that injected line so any *other* runtime error still fails the test.
const ALLOWED_PLAYBACK_ERRORS = [
    /\[playback\] .* failed/,
    /Song API returned no data/,
    /empty song payload/,
    // The injected 503 makes the browser log its own resource-load error.
    /Failed to load resource: the server responded with a status of 503/
];

// P1: when the song-URL API fails, the app must surface a clear error and not
// get stuck (loading spinner cleared, no unhandled runtime error). With a
// single queued song there is no fallback, so the "no playable song" path runs.
test('failing song URL surfaces clear error without getting stuck', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    const errors = collectUnexpectedErrors(page, ALLOWED_PLAYBACK_ERRORS);
    await installAudioProbe(page);
    mockSearchSuccess(page);

    // Fail every song-detail request deterministically.
    let songRequests = 0;
    await page.route(/\/163_music\?/, async (route) => {
        songRequests += 1;
        await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ code: 503, message: 'injected song failure' })
        });
    });

    await page.goto('/index.html');
    await waitForAppReady(page);

    // Seed a single song into the queue via the real search + add UI.
    const search = await openSearch(page, projectName);
    await submitSearch(page, projectName, search.input);
    await expect(search.results.getByText(SEARCH_RESULT.name, { exact: true })).toBeVisible();
    await search.results.getByRole('button', { name: '加入播放列表（不立即播放）' }).first().click();
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(1);

    // Attempt to play the only song; its URL fetch will fail.
    await page.evaluate(() => window.playSongAtIndex(0));

    // The failure must reach the user as a clear, non-empty error toast.
    const toast = page.locator('#copyToast span');
    await expect(toast).toContainText('没有可播放歌曲');

    // The song endpoint was actually exercised (boundary hit, not skipped).
    expect(songRequests).toBeGreaterThanOrEqual(1);

    // Not stuck: the loader overlay is cleared and the actual main Audio
    // constructed by the app was explicitly paused by the failure path.
    const overlayId = projectName === 'mobile-chromium' ? '#mobileLoaderOverlay' : '#desktopLoaderOverlay';
    await expect(page.locator(overlayId)).toHaveClass(/opacity-0/);
    const mainAudio = await readMainAudioProbe(page);
    expect(mainAudio, 'the app must construct a main Audio instance').not.toBeNull();
    expect(mainAudio.isNativeAudioElement).toBe(true);
    expect(mainAudio.pauseCalls).toBeGreaterThan(0);
    expect(mainAudio.paused).toBe(true);

    // No unexpected runtime error beyond the deliberately injected failure.
    await page.waitForTimeout(500);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('API auth failure stops playback recovery instead of skipping the queue', async ({ page }, testInfo) => {
    const errors = collectUnexpectedErrors(page, ALLOWED_PLAYBACK_ERRORS);
    const secondSong = {
        ...SEARCH_RESULT,
        id: SEARCH_RESULT.id + 1,
        name: '第二首基线测试歌曲'
    };
    mockSearchSuccess(page, [SEARCH_RESULT, secondSong]);

    let songRequests = 0;
    await page.route(/\/163_music\?/, async (route) => {
        songRequests += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 401, msg: 'missing runtime test key' })
        });
    });

    await page.goto('/index.html');
    await waitForAppReady(page);
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByText(SEARCH_RESULT.name, { exact: true })).toBeVisible();
    const addButtons = search.results.getByRole('button', { name: '加入播放列表（不立即播放）' });
    await addButtons.nth(0).click();
    await addButtons.nth(1).click();
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(2);

    await page.evaluate(() => window.playSongAtIndex(0));
    await expect(page.locator('#copyToast span')).toHaveText(
        'API 密钥无效或额度已用完，请在设置中检查密钥'
    );
    await page.waitForTimeout(500);
    expect(songRequests).toBe(1);

    const overlayId = testInfo.project.name === 'mobile-chromium'
        ? '#mobileLoaderOverlay'
        : '#desktopLoaderOverlay';
    await expect(page.locator(overlayId)).toHaveClass(/opacity-0/);
    expect(errors, errors.join('\n')).toEqual([]);
});
