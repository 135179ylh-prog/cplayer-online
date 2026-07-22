import { test, expect } from '@playwright/test';
import {
    dispatchMainAudioProbeEvent,
    installAnimationFrameProbe,
    installRuntimeProbes,
    invokeMediaSessionAction,
    readAnimationFrameProbe,
    readMainAudioProbe,
    readMediaSessionProbe,
    readQueueRecord,
    rejectNextMainAudioPlay,
    setMainAudioProbeState,
    setTestDocumentVisibility,
    waitForAppReady
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

function makeSong(id, name) {
    return {
        id,
        name,
        artist: '边界测试歌手',
        album: '边界测试专辑',
        cover: '',
        source: 'E2E fixture'
    };
}

const SONG_A = makeSong(971001, '运行时测试歌曲 A');
const SONG_B = makeSong(971002, '运行时测试歌曲 B');
const SONG_C = makeSong(971004, '运行时测试歌曲 C');
const READY_SONG = makeSong(971003, '就绪恢复测试歌曲');

function songPayload(song) {
    return {
        code: 200,
        data: {
            id: song.id,
            name: song.name,
            artist: song.artist,
            picUrl: '',
            url: `https://media.example.test/${song.id}.mp3`,
            level: 'standard',
            br: 128000
        }
    };
}

async function installPlaybackBoundary(page, songs, options = {}) {
    const songsById = new Map(songs.map((song) => [String(song.id), song]));
    const requestedSongIds = [];
    const heldSongId = options.holdSongId == null ? '' : String(options.holdSongId);
    let releaseHeldRequests;
    let resolveHeldRequest;
    const releaseGate = new Promise((resolve) => { releaseHeldRequests = resolve; });
    const heldRequest = new Promise((resolve) => { resolveHeldRequest = resolve; });

    await page.route(/\/163_music\?/, async (route) => {
        const requestUrl = new URL(route.request().url());
        const songId = requestUrl.searchParams.get('id') || '';
        requestedSongIds.push(songId);
        const song = songsById.get(songId);
        if (!song) {
            await route.fulfill({
                status: 404,
                contentType: 'application/json',
                body: JSON.stringify({ code: 404, message: 'unknown generated song' })
            });
            return;
        }
        if (heldSongId && songId === heldSongId) {
            resolveHeldRequest(songId);
            await releaseGate;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(songPayload(song))
        });
    });

    await page.route(/\/163_lyric\?/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { lrc: '', tlyric: '' } })
        });
    });

    return {
        heldRequest,
        requestedSongIds,
        release: () => releaseHeldRequests()
    };
}

async function addSongsToQueue(page, songs) {
    await page.evaluate((queueSongs) => {
        for (const song of queueSongs) window.addSongToQueueOnly(song, { toast: false });
    }, songs);
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(songs.length);
}

async function playSongAndWaitForCommit(page, index, song) {
    await page.evaluate((songIndex) => window.playSongAtIndex(songIndex), index);
    await expect.poll(async () => (await readMainAudioProbe(page))?.src || '').toContain(String(song.id));
    await expect.poll(async () => (await readMainAudioProbe(page))?.playCalls || 0).toBeGreaterThan(0);
    await expect.poll(async () => (await readMediaSessionProbe(page))?.metadata?.title || '').toBe(song.name);
}

async function waitForAnimationSchedulingToSettle(page) {
    let previous = await readAnimationFrameProbe(page);
    let stableRounds = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(75);
        const current = await readAnimationFrameProbe(page);
        if (current.requested === previous.requested && current.pending === 0) {
            stableRounds += 1;
            if (stableRounds === 2) return current;
        } else {
            stableRounds = 0;
        }
        previous = current;
    }
    throw new Error(`Animation scheduling did not settle: ${JSON.stringify(previous)}`);
}

async function sampleAnimationActivity(page, duration = 200) {
    const before = await readAnimationFrameProbe(page);
    await page.waitForTimeout(duration);
    const after = await readAnimationFrameProbe(page);
    return {
        before,
        after,
        requested: after.requested - before.requested,
        executed: after.executed - before.executed
    };
}

function recurringCallbackDeltas(sample) {
    const beforeById = new Map(sample.before.callbacks.map((stats) => [stats.id, stats]));
    return sample.after.callbacks.map((stats) => {
        const before = beforeById.get(stats.id) || { requested: 0, executed: 0 };
        return {
            ...stats,
            requestedDelta: stats.requested - before.requested,
            executedDelta: stats.executed - before.executed
        };
    }).filter((stats) => stats.requestedDelta >= 3 && stats.executedDelta >= 3);
}

function expectNoRecurringAnimation(sample) {
    expect(sample.requested).toBe(0);
    expect(sample.executed).toBe(0);
    expect(sample.after.pending).toBe(0);
    expect(recurringCallbackDeltas(sample)).toEqual([]);
}

test('explicit app-ready signal includes restored queue and required handlers', async ({ page }) => {
    await installRuntimeProbes(page);
    await page.goto('/index.html');
    await waitForAppReady(page);

    const firstBoot = await page.evaluate(() => ({
        ready: document.documentElement.dataset.cplayerReady,
        queueApiReady: typeof window.addSongToQueueOnly === 'function',
        mobileUiReady: Boolean(window.mobileUI)
    }));
    expect(firstBoot).toEqual({ ready: 'true', queueApiReady: true, mobileUiReady: true });
    expect((await readMediaSessionProbe(page)).actions).toEqual(expect.arrayContaining(['play', 'pause']));

    await addSongsToQueue(page, [READY_SONG]);
    await expect.poll(async () => (await readQueueRecord(page))?.songs?.length || 0).toBe(1);

    await page.reload();
    await waitForAppReady(page);

    const restoredBoot = await page.evaluate(() => ({
        ready: document.documentElement.dataset.cplayerReady,
        songIds: window.playlist.map((song) => song.id),
        queueApiReady: typeof window.removeSongFromQueue === 'function',
        mobileUiReady: Boolean(window.mobileUI)
    }));
    expect(restoredBoot).toEqual({
        ready: 'true',
        songIds: [READY_SONG.id],
        queueApiReady: true,
        mobileUiReady: true
    });
    expect((await readMediaSessionProbe(page)).actions).toEqual(expect.arrayContaining(['play', 'pause']));
});

test('pagehide while song B is pending persists song A media time under song A', async ({ page }) => {
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    const boundary = await installPlaybackBoundary(page, [SONG_A, SONG_B], { holdSongId: SONG_B.id });

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A, SONG_B]);
    await playSongAndWaitForCommit(page, 0, SONG_A);

    await setMainAudioProbeState(page, {
        currentTime: 61,
        duration: 180,
        paused: false,
        ended: false
    });
    await dispatchMainAudioProbeEvent(page, 'timeupdate');
    await page.evaluate(() => localStorage.removeItem('cp_playback_session'));

    await page.evaluate(() => window.playSongAtIndex(1));
    await boundary.heldRequest;

    try {
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
        });
        const session = await page.evaluate(() => JSON.parse(localStorage.getItem('cp_playback_session')));
        expect(session).toMatchObject({
            songId: String(SONG_A.id),
            currentIndex: 0,
            currentTime: 61,
            duration: 180
        });
    } finally {
        boundary.release();
    }
});

test('system play resumes committed song A while song B is still pending', async ({ page }) => {
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    const boundary = await installPlaybackBoundary(page, [SONG_A, SONG_B], { holdSongId: SONG_B.id });

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A, SONG_B]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    await page.evaluate(() => window.__cplayerAudioProbe.instances[0].pause());
    await expect.poll(async () => (await readMainAudioProbe(page)).paused).toBe(true);

    try {
        await page.evaluate(() => window.playSongAtIndex(1));
        await boundary.heldRequest;
        const beforePlay = await readMainAudioProbe(page);
        await invokeMediaSessionAction(page, 'play');
        await expect.poll(async () => (await readMainAudioProbe(page)).playCalls)
            .toBeGreaterThan(beforePlay.playCalls);
        const resumed = await readMainAudioProbe(page);
        expect(resumed.src).toContain(String(SONG_A.id));
        expect(resumed.paused).toBe(false);
    } finally {
        boundary.release();
    }
    await expect.poll(async () => (await readMainAudioProbe(page)).src).toContain(String(SONG_B.id));
});

test('ended committed media does not skip a pending user-selected song', async ({ page }) => {
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    const boundary = await installPlaybackBoundary(page, [SONG_A, SONG_B, SONG_C], { holdSongId: SONG_B.id });

    await page.goto('/index.html');
    await waitForAppReady(page);
    await page.evaluate(() => window.setPlayMode('sequence', { notify: false }));
    await addSongsToQueue(page, [SONG_A, SONG_C, SONG_B]);
    expect(await page.evaluate(() => window.playlist.map((song) => song.id)))
        .toEqual([SONG_A.id, SONG_B.id, SONG_C.id]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    await page.evaluate((songId) => {
        const index = window.playlist.findIndex((song) => String(song.id) === String(songId));
        window.playSongAtIndex(index);
    }, SONG_B.id);
    await boundary.heldRequest;

    await setMainAudioProbeState(page, { currentTime: 180, duration: 180, paused: true, ended: true });
    await dispatchMainAudioProbeEvent(page, 'ended');
    await page.waitForTimeout(150);
    expect(boundary.requestedSongIds).not.toContain(String(SONG_C.id));
    expect((await readMainAudioProbe(page)).src).toContain(String(SONG_A.id));

    boundary.release();
    await expect.poll(async () => (await readMainAudioProbe(page)).src).toContain(String(SONG_B.id));
});

test('autoplay rejection after a source switch synchronizes paused state and can recover', async ({ page }) => {
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    await installPlaybackBoundary(page, [SONG_A, SONG_B]);

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A, SONG_B]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    await rejectNextMainAudioPlay(page);
    await page.evaluate(() => window.playSongAtIndex(1));
    await expect.poll(async () => (await readMainAudioProbe(page)).src).toContain(String(SONG_B.id));
    await expect.poll(async () => (await readMainAudioProbe(page)).paused).toBe(true);
    expect((await readMediaSessionProbe(page)).playbackState).toBe('paused');

    await invokeMediaSessionAction(page, 'play');
    await expect.poll(async () => (await readMainAudioProbe(page)).paused).toBe(false);
    expect((await readMediaSessionProbe(page)).playbackState).toBe('playing');
});

test('removing the final queue item resets media and invalidates a captured play handler', async ({ page }) => {
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    await installPlaybackBoundary(page, [SONG_A]);

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    await setMainAudioProbeState(page, { currentTime: 30, duration: 180, paused: false });
    await dispatchMainAudioProbeEvent(page, 'timeupdate');

    const beforeAudio = await readMainAudioProbe(page);
    const beforeMediaSession = await readMediaSessionProbe(page);
    expect(beforeMediaSession.positionState).toMatchObject({ duration: 180, position: 30 });
    expect(await page.evaluate(() => {
        window.__capturedCPlayerPlayHandler = window.__cplayerMediaSessionProbe.handlers.play;
        return typeof window.__capturedCPlayerPlayHandler;
    })).toBe('function');

    await page.evaluate(() => window.removeSongFromQueue(0, { toast: false }));
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(0);
    await expect.poll(async () => (await readMainAudioProbe(page))?.src).toBe('');
    await page.evaluate(() => Promise.resolve());

    const clearedAudio = await readMainAudioProbe(page);
    const clearedMediaSession = await readMediaSessionProbe(page);
    expect(clearedAudio.paused).toBe(true);
    expect(clearedAudio.currentSrc).toBe('');
    expect(clearedAudio.pauseCalls).toBeGreaterThan(beforeAudio.pauseCalls);
    expect(clearedAudio.loadCalls).toBeGreaterThan(beforeAudio.loadCalls);
    expect(clearedMediaSession.metadata).toBeNull();
    expect(clearedMediaSession.playbackState).toBe('none');
    expect(clearedMediaSession.positionState).toBeNull();
    expect(clearedMediaSession.positionStateAssignments.length)
        .toBeGreaterThan(beforeMediaSession.positionStateAssignments.length);
    expect(await page.evaluate(() => localStorage.getItem('cp_playback_session'))).toBeNull();

    const playCallsAfterReset = clearedAudio.playCalls;
    await page.evaluate(async () => {
        await window.__capturedCPlayerPlayHandler({});
    });
    await page.evaluate(() => Promise.resolve());

    const afterCapturedPlay = await readMainAudioProbe(page);
    expect(afterCapturedPlay.playCalls).toBe(playCallsAfterReset);
    expect(afterCapturedPlay.src).toBe('');
    expect(afterCapturedPlay.paused).toBe(true);
    expect((await readMediaSessionProbe(page)).playbackState).toBe('none');
});

test('explicit clear-queue command releases the committed media identity', async ({ page }, testInfo) => {
    await installRuntimeProbes(page, { audio: { duration: 180 } });
    await installPlaybackBoundary(page, [SONG_A, SONG_B]);

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A, SONG_B]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    await setMainAudioProbeState(page, { currentTime: 30, duration: 180, paused: false });
    await dispatchMainAudioProbeEvent(page, 'timeupdate');
    await page.evaluate(() => {
        window.__capturedCPlayerPlayHandler = window.__cplayerMediaSessionProbe.handlers.play;
    });
    const beforeClearAudio = await readMainAudioProbe(page);

    page.once('dialog', (dialog) => dialog.accept());
    let clearButton;
    if (testInfo.project.name === 'mobile-chromium') {
        clearButton = page.locator('#mClearQueueBtnBar');
    } else {
        await page.getByRole('button', { name: '打开播放列表和搜索' }).click();
        await expect(page.locator('#floatingPlaylistPanel')).toBeInViewport({ ratio: 1 });
        clearButton = page.locator('#clearQueueBtn');
    }
    await expect(clearButton).toBeInViewport({ ratio: 1 });
    await clearButton.click();

    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(0);
    await expect.poll(async () => (await readMainAudioProbe(page))?.src).toBe('');
    const clearedAudio = await readMainAudioProbe(page);
    const clearedMediaSession = await readMediaSessionProbe(page);
    expect(clearedAudio.currentSrc).toBe('');
    expect(clearedAudio.paused).toBe(true);
    expect(clearedAudio.loadCalls).toBeGreaterThan(beforeClearAudio.loadCalls);
    expect(clearedMediaSession.metadata).toBeNull();
    expect(clearedMediaSession.positionState).toBeNull();
    expect(clearedMediaSession.playbackState).toBe('none');
    expect(await page.evaluate(() => localStorage.getItem('cp_playback_session'))).toBeNull();

    const playCallsAfterClear = clearedAudio.playCalls;
    await page.evaluate(async () => window.__capturedCPlayerPlayHandler({}));
    expect((await readMainAudioProbe(page)).playCalls).toBe(playCallsAfterClear);
});

test('Media Session seek actions clamp finite targets and publish position state', async ({ page }) => {
    await installRuntimeProbes(page, { audio: { duration: 120 } });
    await installPlaybackBoundary(page, [SONG_A]);

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A]);
    await playSongAndWaitForCommit(page, 0, SONG_A);

    await expect.poll(async () => (await readMediaSessionProbe(page)).actions).toEqual(
        expect.arrayContaining(['seekto', 'seekbackward', 'seekforward'])
    );
    await setMainAudioProbeState(page, { currentTime: 40, duration: 120, paused: false });
    await dispatchMainAudioProbeEvent(page, 'timeupdate');
    await expect.poll(async () => (await readMediaSessionProbe(page)).positionState?.position).toBe(40);

    await invokeMediaSessionAction(page, 'seekforward');
    expect((await readMainAudioProbe(page)).currentTime).toBe(50);
    await invokeMediaSessionAction(page, 'seekbackward');
    expect((await readMainAudioProbe(page)).currentTime).toBe(40);

    await setMainAudioProbeState(page, { currentTime: 5 });
    await invokeMediaSessionAction(page, 'seekbackward', { seekOffset: 30 });
    expect((await readMainAudioProbe(page)).currentTime).toBe(0);

    await setMainAudioProbeState(page, { currentTime: 115 });
    await invokeMediaSessionAction(page, 'seekforward', { seekOffset: 30 });
    expect((await readMainAudioProbe(page)).currentTime).toBe(120);

    await invokeMediaSessionAction(page, 'seekto', { seekTime: -20 });
    expect((await readMainAudioProbe(page)).currentTime).toBe(0);
    await invokeMediaSessionAction(page, 'seekto', { seekTime: 500 });
    expect((await readMainAudioProbe(page)).currentTime).toBe(120);
    await invokeMediaSessionAction(page, 'seekto', { seekTime: 55.5, fastSeek: true });

    const afterValidSeek = await readMainAudioProbe(page);
    const afterValidPosition = await readMediaSessionProbe(page);
    expect(afterValidSeek.currentTime).toBe(55.5);
    expect(afterValidSeek.fastSeekCalls).toBeGreaterThan(0);
    expect(afterValidPosition.positionState).toEqual({
        duration: 120,
        position: 55.5,
        playbackRate: 1
    });

    const expectIgnoredSeek = async (action, details) => {
        const beforeAudio = await readMainAudioProbe(page);
        const beforePosition = await readMediaSessionProbe(page);
        await invokeMediaSessionAction(page, action, details);
        const afterAudio = await readMainAudioProbe(page);
        const afterPosition = await readMediaSessionProbe(page);
        expect(afterAudio.currentTime).toBe(beforeAudio.currentTime);
        expect(afterAudio.currentTimeAssignments).toBe(beforeAudio.currentTimeAssignments);
        expect(afterPosition.positionStateAssignments.length)
            .toBe(beforePosition.positionStateAssignments.length);
    };
    await expectIgnoredSeek('seekto', { seekTime: Number.NaN });
    await expectIgnoredSeek('seekforward', { seekOffset: Number.POSITIVE_INFINITY });
    await expectIgnoredSeek('seekbackward', { seekOffset: Number.NaN });
    await expectIgnoredSeek('seekforward', { seekOffset: 0 });
    await expectIgnoredSeek('seekbackward', { seekOffset: -5 });
});

test('animation work stops while paused or hidden and visible resume starts one loop', async ({ page }) => {
    await installAnimationFrameProbe(page);
    await installRuntimeProbes(page, { audio: { duration: 120 } });
    await installPlaybackBoundary(page, [SONG_A]);

    await page.goto('/index.html');
    await waitForAppReady(page);

    const settledBoot = await waitForAnimationSchedulingToSettle(page);
    expect(settledBoot.hasVisibilityOverride).toBe(true);
    expect(settledBoot.visibilityOverrideConfigurable).toBe(true);
    expect(settledBoot.visibilityState).toBe('visible');
    expectNoRecurringAnimation(await sampleAnimationActivity(page));

    await addSongsToQueue(page, [SONG_A]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    const webglState = await page.evaluate(() => {
        const capabilityCanvas = document.createElement('canvas');
        const capability = capabilityCanvas.getContext('webgl') || capabilityCanvas.getContext('experimental-webgl');
        const appCanvas = document.getElementById('fluidBg');
        const appContext = appCanvas?.getContext('webgl') || appCanvas?.getContext('experimental-webgl');
        return {
            supported: Boolean(capability),
            appHasProgram: Boolean(appContext && appContext.getParameter(appContext.CURRENT_PROGRAM))
        };
    });
    if (webglState.supported) expect(webglState.appHasProgram).toBe(true);
    const hasRenderableWebgl = webglState.supported;

    const visiblePlayback = await sampleAnimationActivity(page);
    if (hasRenderableWebgl) {
        expect(visiblePlayback.requested).toBeGreaterThan(3);
        expect(visiblePlayback.executed).toBeGreaterThan(3);
        const recurring = recurringCallbackDeltas(visiblePlayback);
        expect(recurring).toHaveLength(1);
        expect(recurring[0].pending).toBe(1);
        expect(recurring[0].maxPending).toBe(1);
        expect(visiblePlayback.after.pending).toBe(1);
    } else {
        expectNoRecurringAnimation(visiblePlayback);
    }

    await page.evaluate(() => window.__cplayerAudioProbe.instances[0].pause());
    await expect.poll(async () => (await readMainAudioProbe(page)).paused).toBe(true);
    const settledPause = await waitForAnimationSchedulingToSettle(page);
    if (hasRenderableWebgl) {
        expect(settledPause.canceled).toBeGreaterThan(visiblePlayback.after.canceled);
    }
    expectNoRecurringAnimation(await sampleAnimationActivity(page));

    const beforePausedResize = await readAnimationFrameProbe(page);
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 1 });
    const settledResize = await waitForAnimationSchedulingToSettle(page);
    if (hasRenderableWebgl) {
        expect(settledResize.webglDrawCalls).toBeGreaterThan(beforePausedResize.webglDrawCalls);
    }
    expectNoRecurringAnimation(await sampleAnimationActivity(page));

    const resumeStart = await readAnimationFrameProbe(page);
    await invokeMediaSessionAction(page, 'play');
    await expect.poll(async () => (await readMainAudioProbe(page)).paused).toBe(false);
    if (hasRenderableWebgl) {
        await expect.poll(async () => {
            const current = await readAnimationFrameProbe(page);
            return current.executed - resumeStart.executed;
        }).toBeGreaterThan(2);
    }

    const beforeHidden = await readAnimationFrameProbe(page);
    await setTestDocumentVisibility(page, 'hidden');
    await expect.poll(async () => (await readAnimationFrameProbe(page)).pending).toBe(0);
    const afterHidden = await readAnimationFrameProbe(page);
    if (hasRenderableWebgl) {
        expect(afterHidden.canceled).toBeGreaterThan(beforeHidden.canceled);
    }
    expectNoRecurringAnimation(await sampleAnimationActivity(page));

    await setTestDocumentVisibility(page, 'visible');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const visibleResume = await sampleAnimationActivity(page);
    if (hasRenderableWebgl) {
        expect(visibleResume.requested).toBeGreaterThan(3);
        expect(visibleResume.executed).toBeGreaterThan(3);
        const recurring = recurringCallbackDeltas(visibleResume);
        expect(recurring).toHaveLength(1);
        expect(recurring[0].pending).toBe(1);
        expect(recurring[0].maxPending).toBe(1);
        expect(visibleResume.after.pending).toBe(1);
    } else {
        expectNoRecurringAnimation(visibleResume);
    }
});

test('reduced motion keeps audio playing and stops recurring visual work', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installAnimationFrameProbe(page);
    await installRuntimeProbes(page, { audio: { duration: 120 } });
    await installPlaybackBoundary(page, [SONG_A]);

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    await expect.poll(() => page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

    await waitForAnimationSchedulingToSettle(page);
    expect((await readMainAudioProbe(page)).paused).toBe(false);
    const mobile = testInfo.project.name === 'mobile-chromium';
    const visualIds = mobile
        ? { album: 'mobileAlbumArtWrapper', loader: 'mobileLoaderOverlay', lyrics: 'mobileLyricsScroller' }
        : { album: 'albumArtWrapper', loader: 'desktopLoaderOverlay', lyrics: 'lyricsScroller' };
    const motion = await page.evaluate((ids) => ({
        albumIterationCount: getComputedStyle(document.getElementById(ids.album)).animationIterationCount,
        spinnerIterationCount: getComputedStyle(document.querySelector(`#${ids.loader} .animate-spin`)).animationIterationCount,
        playlistScrollBehavior: getComputedStyle(document.querySelector('.playlist-songs')).scrollBehavior,
        lyricsScrollBehavior: getComputedStyle(document.getElementById(ids.lyrics)).scrollBehavior
    }), visualIds);
    expect(motion.albumIterationCount).not.toBe('infinite');
    expect(motion.spinnerIterationCount).not.toBe('infinite');
    expect(motion.playlistScrollBehavior).toBe('auto');
    expect(motion.lyricsScrollBehavior).toBe('auto');
    expectNoRecurringAnimation(await sampleAnimationActivity(page));
});

test('switching reduced motion cancels and can restore the visual loop', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installAnimationFrameProbe(page);
    await installRuntimeProbes(page, { audio: { duration: 120 } });
    await installPlaybackBoundary(page, [SONG_A]);

    await page.goto('/index.html');
    await waitForAppReady(page);
    await addSongsToQueue(page, [SONG_A]);
    await playSongAndWaitForCommit(page, 0, SONG_A);
    const webglState = await page.evaluate(() => {
        const capabilityCanvas = document.createElement('canvas');
        const capability = capabilityCanvas.getContext('webgl') || capabilityCanvas.getContext('experimental-webgl');
        const appCanvas = document.getElementById('fluidBg');
        const appContext = appCanvas?.getContext('webgl') || appCanvas?.getContext('experimental-webgl');
        return {
            supported: Boolean(capability),
            appHasProgram: Boolean(appContext && appContext.getParameter(appContext.CURRENT_PROGRAM))
        };
    });
    const hasRenderableWebgl = webglState.supported && webglState.appHasProgram;
    const visible = await sampleAnimationActivity(page);
    if (hasRenderableWebgl) expect(recurringCallbackDeltas(visible)).toHaveLength(1);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await expect.poll(async () => (await readAnimationFrameProbe(page)).pending).toBe(0);
    expectNoRecurringAnimation(await sampleAnimationActivity(page));
    expect((await readMainAudioProbe(page)).paused).toBe(false);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
    const resumed = await sampleAnimationActivity(page);
    if (hasRenderableWebgl) expect(recurringCallbackDeltas(resumed)).toHaveLength(1);
    else expectNoRecurringAnimation(resumed);
});
