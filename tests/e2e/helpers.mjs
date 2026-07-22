import { expect } from '@playwright/test';

export const SEARCH_QUERY = '质量基线测试';
export const SEARCH_RESULT = {
    id: 901001,
    name: '基线测试歌曲',
    artists: [{ name: '测试歌手' }],
    album: { name: '测试专辑', picUrl: '' },
    picUrl: ''
};

export function collectUnexpectedErrors(page, allowedPatterns = []) {
    const errors = [];
    const isAllowed = (text) => allowedPatterns.some((pattern) => pattern.test(text));

    page.on('pageerror', (error) => {
        const text = error && error.stack ? error.stack : String(error);
        if (!isAllowed(text)) errors.push(`pageerror: ${text}`);
    });
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!isAllowed(text)) errors.push(`console: ${text}`);
    });

    return errors;
}

// Install before navigation. Each constructed Audio remains a real
// HTMLAudioElement, while its media boundary is deterministic and observable.
export async function installAudioProbe(page, options = {}) {
    const duration = Number.isFinite(options.duration) && options.duration > 0
        ? options.duration
        : 180;

    await page.addInitScript(({ defaultDuration }) => {
        const NativeAudio = window.Audio;
        const instances = [];
        const states = [];
        const records = [];

        function queueEvent(audio, type) {
            queueMicrotask(() => audio.dispatchEvent(new Event(type)));
        }

        function snapshot(index = 0) {
            const audio = instances[index];
            const state = states[index];
            const record = records[index];
            if (!audio || !state || !record) return null;
            return {
                index,
                isNativeAudioElement: audio instanceof HTMLAudioElement,
                src: state.src,
                currentSrc: state.src,
                currentTime: state.currentTime,
                duration: state.duration,
                paused: state.paused,
                ended: state.ended,
                readyState: state.readyState,
                playbackRate: state.playbackRate,
                playCalls: record.playCalls,
                pauseCalls: record.pauseCalls,
                loadCalls: record.loadCalls,
                fastSeekCalls: record.fastSeekCalls,
                currentTimeAssignments: record.currentTimeAssignments,
                srcAssignments: record.srcAssignments.slice()
            };
        }

        function ProbedAudio(initialSrc = '') {
            const audio = new NativeAudio();
            const state = {
                src: '',
                currentTime: 0,
                duration: defaultDuration,
                paused: true,
                ended: false,
                readyState: 0,
                playbackRate: 1
            };
            const record = {
                playCalls: 0,
                pauseCalls: 0,
                loadCalls: 0,
                fastSeekCalls: 0,
                currentTimeAssignments: 0,
                srcAssignments: []
            };
            const nativeSetAttribute = audio.setAttribute.bind(audio);
            const nativeGetAttribute = audio.getAttribute.bind(audio);
            const nativeRemoveAttribute = audio.removeAttribute.bind(audio);

            Object.defineProperties(audio, {
                src: {
                    configurable: true,
                    get: () => state.src,
                    set: (value) => {
                        state.src = String(value || '');
                        state.currentTime = 0;
                        state.paused = true;
                        state.ended = false;
                        state.readyState = state.src ? 4 : 0;
                        state.duration = state.src ? defaultDuration : Number.NaN;
                        record.srcAssignments.push(state.src);
                        if (state.src) queueEvent(audio, 'loadedmetadata');
                    }
                },
                currentSrc: { configurable: true, get: () => state.src },
                currentTime: {
                    configurable: true,
                    get: () => state.currentTime,
                    set: (value) => {
                        const next = Number(value);
                        if (!Number.isFinite(next)) throw new TypeError('provided double value is non-finite');
                        record.currentTimeAssignments += 1;
                        state.currentTime = next;
                    }
                },
                duration: { configurable: true, get: () => state.duration },
                paused: { configurable: true, get: () => state.paused },
                ended: { configurable: true, get: () => state.ended },
                readyState: { configurable: true, get: () => state.readyState },
                playbackRate: {
                    configurable: true,
                    get: () => state.playbackRate,
                    set: (value) => {
                        const next = Number(value);
                        if (Number.isFinite(next) && next > 0) state.playbackRate = next;
                    }
                },
                error: { configurable: true, get: () => null }
            });

            audio.setAttribute = (name, value) => {
                if (String(name).toLowerCase() === 'src') {
                    audio.src = value;
                    return;
                }
                nativeSetAttribute(name, value);
            };
            audio.getAttribute = (name) => String(name).toLowerCase() === 'src'
                ? (state.src || null)
                : nativeGetAttribute(name);
            audio.removeAttribute = (name) => {
                if (String(name).toLowerCase() === 'src') {
                    audio.src = '';
                    return;
                }
                nativeRemoveAttribute(name);
            };
            audio.play = () => {
                record.playCalls += 1;
                if (!state.src) {
                    return Promise.reject(new DOMException('No media source', 'NotSupportedError'));
                }
                if (state.nextPlayError) {
                    const nextError = state.nextPlayError;
                    state.nextPlayError = null;
                    state.paused = true;
                    return Promise.reject(new DOMException(nextError.message, nextError.name));
                }
                state.paused = false;
                state.ended = false;
                queueEvent(audio, 'play');
                return Promise.resolve();
            };
            audio.pause = () => {
                record.pauseCalls += 1;
                const wasPaused = state.paused;
                state.paused = true;
                if (!wasPaused) queueEvent(audio, 'pause');
            };
            audio.load = () => {
                record.loadCalls += 1;
                state.readyState = state.src ? 4 : 0;
                if (!state.src) {
                    state.currentTime = 0;
                    state.duration = Number.NaN;
                }
            };
            audio.fastSeek = (value) => {
                record.fastSeekCalls += 1;
                audio.currentTime = value;
            };

            instances.push(audio);
            states.push(state);
            records.push(record);
            state.nextPlayError = null;
            if (initialSrc) audio.src = initialSrc;
            return audio;
        }

        ProbedAudio.prototype = NativeAudio.prototype;
        Object.setPrototypeOf(ProbedAudio, NativeAudio);

        window.Audio = ProbedAudio;
        window.__cplayerAudioProbe = {
            instances,
            snapshot,
            setState(index, patch) {
                const state = states[index];
                if (!state || !patch) return false;
                for (const key of ['currentTime', 'duration', 'playbackRate']) {
                    if (Object.prototype.hasOwnProperty.call(patch, key)) {
                        state[key] = Number(patch[key]);
                    }
                }
                for (const key of ['paused', 'ended']) {
                    if (Object.prototype.hasOwnProperty.call(patch, key)) {
                        state[key] = Boolean(patch[key]);
                    }
                }
                if (Object.prototype.hasOwnProperty.call(patch, 'readyState')) {
                    state.readyState = Number(patch.readyState);
                }
                if (Object.prototype.hasOwnProperty.call(patch, 'src')) {
                    instances[index].src = patch.src;
                }
                return true;
            },
            dispatch(index, type) {
                const audio = instances[index];
                if (!audio) return false;
                audio.dispatchEvent(new Event(type));
                return true;
            },
            rejectNextPlay(index, name = 'NotAllowedError', message = 'autoplay blocked') {
                const state = states[index];
                if (!state) return false;
                state.nextPlayError = { name, message };
                return true;
            }
        };
    }, { defaultDuration: duration });
}

// Install before navigation so production registers handlers against this
// browser-boundary probe instead of Chromium's host Media Session object.
export async function installMediaSessionProbe(page) {
    await page.addInitScript(() => {
        const handlers = Object.create(null);
        const state = {
            metadata: null,
            playbackState: 'none',
            positionState: null,
            metadataAssignments: [],
            playbackStateAssignments: [],
            positionStateAssignments: []
        };

        function clone(value) {
            if (value == null) return null;
            return JSON.parse(JSON.stringify(value));
        }

        class ProbedMediaMetadata {
            constructor(init = {}) {
                this.title = init.title || '';
                this.artist = init.artist || '';
                this.album = init.album || '';
                this.artwork = Array.isArray(init.artwork) ? clone(init.artwork) : [];
            }
        }

        const mediaSession = {
            get metadata() {
                return state.metadata;
            },
            set metadata(value) {
                state.metadata = value == null ? null : clone(value);
                state.metadataAssignments.push(clone(state.metadata));
            },
            get playbackState() {
                return state.playbackState;
            },
            set playbackState(value) {
                state.playbackState = String(value);
                state.playbackStateAssignments.push(state.playbackState);
            },
            setActionHandler(action, handler) {
                handlers[action] = handler;
            },
            setPositionState(positionState) {
                state.positionState = arguments.length === 0 ? null : clone(positionState);
                state.positionStateAssignments.push(clone(state.positionState));
            }
        };

        Object.defineProperty(navigator, 'mediaSession', {
            configurable: true,
            value: mediaSession
        });
        window.MediaMetadata = ProbedMediaMetadata;
        window.__cplayerMediaSessionProbe = {
            handlers,
            snapshot() {
                return {
                    actions: Object.keys(handlers).sort(),
                    metadata: clone(state.metadata),
                    playbackState: state.playbackState,
                    positionState: clone(state.positionState),
                    metadataAssignments: clone(state.metadataAssignments),
                    playbackStateAssignments: state.playbackStateAssignments.slice(),
                    positionStateAssignments: clone(state.positionStateAssignments)
                };
            },
            invoke(action, details = {}) {
                const handler = handlers[action];
                if (typeof handler !== 'function') throw new Error(`Missing Media Session handler: ${action}`);
                return handler(details);
            }
        };
    });
}

// Track real browser frame scheduling while letting callbacks run normally.
// The visibility override is test-owned and installed before app code reads it.
export async function installAnimationFrameProbe(page) {
    await page.addInitScript(() => {
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        const callbackIds = new WeakMap();
        const callbackStats = new Map();
        const pendingFrames = new Map();
        let nextCallbackId = 1;
        let requested = 0;
        let executed = 0;
        let canceled = 0;
        let maxPending = 0;
        let webglDrawCalls = 0;
        let visibilityState = 'visible';

        const webglPrototype = window.WebGLRenderingContext?.prototype;
        const nativeDrawArrays = webglPrototype?.drawArrays;
        if (webglPrototype && typeof nativeDrawArrays === 'function') {
            webglPrototype.drawArrays = function (...args) {
                webglDrawCalls += 1;
                return nativeDrawArrays.apply(this, args);
            };
        }

        Object.defineProperties(document, {
            visibilityState: {
                configurable: true,
                get: () => visibilityState
            },
            hidden: {
                configurable: true,
                get: () => visibilityState === 'hidden'
            }
        });

        function getCallbackStats(callback) {
            let callbackId = callbackIds.get(callback);
            if (!callbackId) {
                callbackId = nextCallbackId;
                nextCallbackId += 1;
                callbackIds.set(callback, callbackId);
                callbackStats.set(callbackId, {
                    id: callbackId,
                    name: callback.name || '',
                    requested: 0,
                    executed: 0,
                    canceled: 0,
                    pending: 0,
                    maxPending: 0
                });
            }
            return callbackStats.get(callbackId);
        }

        window.requestAnimationFrame = (callback) => {
            const stats = getCallbackStats(callback);
            requested += 1;
            stats.requested += 1;
            let frameId;
            frameId = nativeRequestAnimationFrame((timestamp) => {
                const pending = pendingFrames.get(frameId);
                if (pending) {
                    pendingFrames.delete(frameId);
                    pending.stats.pending -= 1;
                }
                executed += 1;
                stats.executed += 1;
                callback(timestamp);
            });
            pendingFrames.set(frameId, { stats });
            stats.pending += 1;
            stats.maxPending = Math.max(stats.maxPending, stats.pending);
            maxPending = Math.max(maxPending, pendingFrames.size);
            return frameId;
        };

        window.cancelAnimationFrame = (frameId) => {
            const pending = pendingFrames.get(frameId);
            if (pending) {
                pendingFrames.delete(frameId);
                pending.stats.pending -= 1;
                pending.stats.canceled += 1;
                canceled += 1;
            }
            nativeCancelAnimationFrame(frameId);
        };

        window.__cplayerAnimationFrameProbe = {
            snapshot() {
                return {
                    requested,
                    executed,
                    canceled,
                    pending: pendingFrames.size,
                    maxPending,
                    webglDrawCalls,
                    visibilityState,
                    hasVisibilityOverride: Object.prototype.hasOwnProperty.call(document, 'visibilityState'),
                    visibilityOverrideConfigurable: Object.getOwnPropertyDescriptor(document, 'visibilityState')?.configurable === true,
                    callbacks: Array.from(callbackStats.values()).map((stats) => ({ ...stats }))
                };
            },
            setVisibility(nextState, dispatch = true) {
                if (nextState !== 'visible' && nextState !== 'hidden') {
                    throw new Error(`Unsupported test visibility state: ${nextState}`);
                }
                visibilityState = nextState;
                if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
            }
        };
    });
}

export async function installRuntimeProbes(page, options = {}) {
    await installAudioProbe(page, options.audio);
    await installMediaSessionProbe(page);
}

export async function readMainAudioProbe(page) {
    return page.evaluate(() => window.__cplayerAudioProbe?.snapshot(0) || null);
}

export async function setMainAudioProbeState(page, state) {
    return page.evaluate((patch) => window.__cplayerAudioProbe?.setState(0, patch) || false, state);
}

export async function rejectNextMainAudioPlay(page, name = 'NotAllowedError', message = 'autoplay blocked') {
    return page.evaluate(({ errorName, errorMessage }) => (
        window.__cplayerAudioProbe?.rejectNextPlay(0, errorName, errorMessage) || false
    ), { errorName: name, errorMessage: message });
}

export async function dispatchMainAudioProbeEvent(page, type) {
    return page.evaluate((eventType) => window.__cplayerAudioProbe?.dispatch(0, eventType) || false, type);
}

export async function readMediaSessionProbe(page) {
    return page.evaluate(() => window.__cplayerMediaSessionProbe?.snapshot() || null);
}

export async function readAnimationFrameProbe(page) {
    return page.evaluate(() => window.__cplayerAnimationFrameProbe?.snapshot() || null);
}

export async function setTestDocumentVisibility(page, visibilityState, dispatch = true) {
    return page.evaluate(({ nextState, shouldDispatch }) => {
        window.__cplayerAnimationFrameProbe.setVisibility(nextState, shouldDispatch);
    }, { nextState: visibilityState, shouldDispatch: dispatch });
}

export async function invokeMediaSessionAction(page, action, details = {}) {
    return page.evaluate(async ({ actionName, actionDetails }) => {
        return window.__cplayerMediaSessionProbe.invoke(actionName, actionDetails);
    }, { actionName: action, actionDetails: details });
}

export async function openSearch(page, projectName) {
    if (projectName === 'mobile-chromium') {
        await page.waitForFunction(() => Boolean(window.mobileUI));
        await page.getByRole('button', { name: '打开播放列表' }).click();
        const panel = page.locator('#mobilePlaylistSheet');
        await expect(panel).toHaveClass(/translate-y-0/);
        await expect(panel).toBeInViewport({ ratio: 1 });
        await page.locator('#sheetTabSearch').click();
        return {
            input: page.locator('#mobileSearchInput'),
            results: page.locator('#mobileSearchResults'),
            panel
        };
    }

    await page.getByRole('button', { name: '打开播放列表和搜索' }).click();
    const panel = page.locator('#floatingPlaylistPanel');
    await expect(panel).not.toHaveClass(/translate-x-full/);
    await expect(panel).toBeInViewport({ ratio: 1 });
    await page.locator('#desktopTabSearch').click();
    return {
        input: page.locator('#searchInput'),
        results: page.locator('#searchResults'),
        panel
    };
}

export async function submitSearch(page, projectName, input) {
    await input.fill(SEARCH_QUERY);
    if (projectName === 'mobile-chromium') {
        await input.press('Enter');
    } else {
        await page.locator('#searchButton').click();
    }
}

// Route the third-party search endpoint to a deterministic success payload.
// Returns a counter object so callers can assert the boundary was exercised.
export function mockSearchSuccess(page, results = [SEARCH_RESULT]) {
    const state = { requestCount: 0, urls: [] };
    page.route(/\/163_search\?/, async (route) => {
        state.requestCount += 1;
        state.urls.push(route.request().url());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: results })
        });
    });
    return state;
}

// The app publishes this only after restore and required UI/system handlers.
export async function waitForAppReady(page) {
    await page.waitForFunction(() => document.documentElement.dataset.cplayerReady === 'true');
}

// Read the persisted play-queue record straight from IndexedDB so tests assert
// real storage, not just in-memory state. Returns null when absent.
export async function readQueueRecord(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 3);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('playlists', 'readonly');
            const get = tx.objectStore('playlists').get('current_queue');
            get.onsuccess = () => { resolve(get.result || null); db.close(); };
            get.onerror = () => { reject(get.error); db.close(); };
        };
    }));
}

// List only the user-playlist records (id prefix user_pl_) from IndexedDB.
export async function readUserPlaylists(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 3);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('playlists', 'readonly');
            const all = tx.objectStore('playlists').getAll();
            all.onsuccess = () => {
                const rows = (all.result || []).filter((r) => String(r.id).startsWith('user_pl_'));
                resolve(rows);
                db.close();
            };
            all.onerror = () => { reject(all.error); db.close(); };
        };
    }));
}

// Open the shared music-library modal (desktop + mobile use the same element).
export async function openLibrary(page) {
    await page.evaluate(() => window.openMyPlaylists());
    await expect(page.locator('#myPlaylistsModal')).toBeVisible();
}

export async function openSettings(page) {
    await waitForAppReady(page);
    await page.getByRole('button', { name: '打开设置' }).click();
    await expect(page.locator('#settingsModal')).toBeVisible();
}

export async function closeSettings(page) {
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(page.locator('#settingsModal')).toBeHidden();
}
