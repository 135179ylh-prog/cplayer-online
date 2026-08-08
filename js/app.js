        import {
            API_REQUEST_RETRIES,
            API_REQUEST_TIMEOUT_MS,
            API_RETRY_DELAY_MS,
            PLAYBACK_SESSION_VERSION,
            SEARCH_PAGE_SIZE,
            clampMediaSeekTime,
            classifyPlaybackFailure,
            classifyPlaybackQuality,
            fetchJsonWithRetry,
            getSafePlaybackResumeTime,
            getSleepTimerRemainingMs,
            mergeUniqueSearchSongs,
            normalizePlaybackSession,
            normalizeSearchPage,
            normalizeSongObject
        } from './core-utils.js';
        import {
            CLOUD_MAX_PLAYLISTS,
            CPlayerCloudService,
            decidePlaylistSync,
            diffPlaylistContent,
            getPlaylistTrashRemainingDays,
            haveSamePlaylistContent,
            isPlaylistTrashExpired,
            isSameCloudMutation,
            isCloudConflictError,
            makeRecoveredPlaylistName,
            makeCloudOutboxId,
            normalizeCloudConfig,
            normalizePlaylistVersion,
            projectCloudSyncStatus,
            selectRetainedPlaylistVersions,
            toCloudPlaylistInput
        } from './cloud-sync.js';
        import { FluidBackground } from './fluid-background.js';
        import { LyricsCanvasRenderer } from './lyrics-canvas.js';
        import { MobileUIManager } from './mobile-ui.js';
        import {
            cleanupSearchResultPager,
            configureSearchView,
            createSearchResultPager,
            renderSearchRecoveryState,
            searchSongs
        } from './search-view.js';

        // 监听 plusready 事件，增加原生能力支持
        document.addEventListener('plusready', function () {
            // 锁定屏幕方向为竖屏
            plus.screen.lockOrientation("portrait-primary");
            // 设置系统音量控制 (初始化音频模块)
            plus.audio.createPlayer();
            // 申请电源锁 (WakeLock) 防止锁屏断网/断CPU
            plus.device.setWakelock(true);
            // 重写 Android 返回键逻辑
            plus.key.addEventListener("backbutton", function () {
                // 隐藏应用到后台而不是退出
                var main = plus.android.runtimeMainActivity();
                main.moveTaskToBack(false);
            });
        });

        // ================= 架构核心：ChKSz API (整合版) =================

        const apiBaseMeta = document.querySelector('meta[name="cplayer-api-base-url"]');
        const STORAGE_WARNING = '浏览器存储不可用，本次修改可能无法保留';
        const STORAGE_STATE_PRIORITY = {
            initializing: -1,
            ready: 0,
            degraded: 1,
            blocked: 2,
            conflict: 3,
            stale: 4
        };
        let storageState = 'initializing';
        let storageStatePriority = STORAGE_STATE_PRIORITY.initializing;
        let pendingStorageWarning = '';
        let shownStorageWarning = '';
        let storageWarningUiReady = false;

        document.documentElement.dataset.cplayerStorageState = storageState;

        function flushStorageWarning() {
            if (!pendingStorageWarning || pendingStorageWarning === shownStorageWarning) return;
            if (!storageWarningUiReady || typeof showToast !== 'function' || !document.getElementById('copyToast')) return;
            shownStorageWarning = pendingStorageWarning;
            showToast(pendingStorageWarning, true);
        }

        function setStorageState(nextState, message, error) {
            const nextPriority = Object.prototype.hasOwnProperty.call(STORAGE_STATE_PRIORITY, nextState)
                ? STORAGE_STATE_PRIORITY[nextState]
                : STORAGE_STATE_PRIORITY.degraded;
            if (nextPriority >= storageStatePriority) {
                storageState = nextState;
                storageStatePriority = nextPriority;
                document.documentElement.dataset.cplayerStorageState = nextState;
            }
            if (message && nextPriority >= storageStatePriority) pendingStorageWarning = message;
            if (error) console.warn('[storage]', message || nextState, error);
            flushStorageWarning();
        }

        function readLocalStorage(key, fallback = null) {
            try {
                const value = localStorage.getItem(key);
                return value === null ? fallback : value;
            } catch (error) {
                setStorageState('degraded', STORAGE_WARNING, error);
                return fallback;
            }
        }

        function writeLocalStorage(key, value) {
            try {
                localStorage.setItem(key, value);
                return true;
            } catch (error) {
                setStorageState('degraded', STORAGE_WARNING, error);
                return false;
            }
        }

        function removeLocalStorage(key) {
            try {
                localStorage.removeItem(key);
                return true;
            } catch (error) {
                setStorageState('degraded', STORAGE_WARNING, error);
                return false;
            }
        }

        class ChKSzAPI {
            // 默认地址来自页面 meta，用户可在设置里覆盖（存 localStorage）。
            static get defaultBaseUrl() {
                const value = apiBaseMeta && apiBaseMeta.content ? apiBaseMeta.content.trim() : '';
                if (!value) throw new Error('API 地址未配置');
                return value.replace(/\/+$/, '');
            }

            static get baseUrl() {
                const stored = (readLocalStorage('cp_api_base', '') || '').trim();
                return ChKSzAPI.normalizeBaseUrl(stored) || ChKSzAPI.defaultBaseUrl;
            }

            // 用户的个人密钥，只从 localStorage 读取，绝不写入代码。
            static get apiKey() {
                return (readLocalStorage('cp_api_key', '') || '').trim();
            }

            static normalizeBaseUrl(value) {
                const raw = String(value || '').trim();
                if (!raw) return '';
                try {
                    const parsed = new URL(raw);
                    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
                        !parsed.hostname || parsed.username || parsed.password ||
                        parsed.search || parsed.hash) return '';
                    return parsed.href.replace(/\/+$/, '');
                } catch (e) {
                    return '';
                }
            }

            // 统一拼接请求地址：给定端点路径与查询参数，按需附加 apikey。
            static buildUrl(path, params = {}) {
                const search = new URLSearchParams();
                Object.keys(params).forEach((k) => {
                    const v = params[k];
                    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
                });
                const key = ChKSzAPI.apiKey;
                if (key) search.set('apikey', key);
                const query = search.toString();
                const endpoint = '/' + String(path || '').replace(/^\/+/, '');
                return `${ChKSzAPI.baseUrl}${endpoint}${query ? '?' + query : ''}`;
            }
        }

        async function fetchJsonWithTimeout(url, timeoutMs = API_REQUEST_TIMEOUT_MS) {
            const json = await fetchJsonWithRetry(url, {
                timeoutMs,
                retries: API_REQUEST_RETRIES,
                retryDelayMs: API_RETRY_DELAY_MS
            });
            const apiStatus = json && typeof json === 'object' ? Number(json.code) : 0;
            if (apiStatus === 401 || apiStatus === 403) {
                const upstreamMessage = json.msg || json.message || 'API authentication failed';
                const error = new Error(String(upstreamMessage));
                error.name = 'ApiAuthError';
                error.status = apiStatus;
                error.retryable = false;
                throw error;
            }
            return json;
        }

        class MusicService {
            constructor() {
                this.loadSettings();
            }

            loadSettings() {
                this.config = {
                    quality: readLocalStorage('cp_quality', 'jymaster') || 'jymaster'
                };
            }

            saveSettings(key, value) {
                if (key === 'source') return;
                this.config[key] = value;
                return writeLocalStorage(`cp_${key}`, value);
            }

            async searchPage(query, options = {}) {
                const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
                const limit = Number.isInteger(options.limit) && options.limit > 0
                    ? options.limit
                    : SEARCH_PAGE_SIZE;
                const url = ChKSzAPI.buildUrl('/163_search', { keyword: query, limit, offset });
                try {
                    const json = await fetchJsonWithTimeout(url);
                    if (json.code === 200) {
                        const page = normalizeSearchPage(json, { offset, limit });
                        const songs = mergeUniqueSearchSongs([], page.items.map(item => normalizeSongObject({
                            ...item,
                            cover: item.picUrl || (item.album ? item.album.picUrl : '') || '',
                            source: 'ChKSz'
                        })));
                        return { ...page, songs };
                    }
                } catch (e) {
                    console.error('Search API Error:', e);
                    throw e;
                }
                return { songs: [], total: 0, offset, nextOffset: offset, hasMore: false };
            }

            async getSong(id) {
                const level = (this.config && this.config.quality) ? this.config.quality : 'jymaster';
                const url = ChKSzAPI.buildUrl('/163_music', { id, level });
                const json = await fetchJsonWithTimeout(url);
                if (json.code === 200 && json.data) {
                    const d = Array.isArray(json.data) ? json.data[0] : json.data;
                    if (d && d.url) {
                        return {
                            id: d.id, url: d.url, name: d.name, artist: d.artist, cover: d.picUrl, source: 'ChKSz', level: typeof d.level === 'string' ? d.level : null, br: d.br ?? d.bitrate
                        };
                    }
                }
                throw new Error('ChKSz GetSong Failed');
            }

            async getLyric(id) {
                const url = ChKSzAPI.buildUrl('/163_lyric', { id });
                try {
                    const json = await fetchJsonWithTimeout(url);
                    if (json.code === 200 && json.data) {
                        return { lrc: json.data.lrc || '', tlrc: json.data.tlyric || '', yrc: '' };
                    }
                } catch (e) {
                    const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
                    if (failure.kind === 'auth' && typeof showToast === 'function') showToast(failure.message, true);
                    console.warn('ChKSz Lyric Failed:', e);
                }
                return null;
            }
        }

        class LyricService {
            static async fetchLyrics(songId) {
                return new MusicService().getLyric(songId);
            }
        }

        // ================= 业务逻辑 =================
        const musicService = new MusicService();

        let audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.volume = 0.5;
        audio.playsInline = true;
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        audio.preload = 'auto';

        // 预加载音频（用于无缝播放）
        let preloadAudio = new Audio();
        preloadAudio.crossOrigin = 'anonymous';
        preloadAudio.volume = 0;
        preloadAudio.preload = 'auto';
        let preloadedNextMedia = null;

        let audioContext, analyser, gainNode, isPlaying = false;
        let playlist = [], currentIndex = -1, playMode = 'shuffle';

        // Canonical play modes. Legacy values are migrated when read.
        const PLAY_MODES = ['sequence', 'repeat_one', 'repeat_all', 'shuffle'];
        const PLAY_MODE_LABELS = { sequence: '顺序播放', repeat_one: '单曲循环', repeat_all: '列表循环', shuffle: '随机播放' };
        const PLAY_MODE_ICONS = { sequence: 'fa-list-ol', repeat_one: 'fa-repeat', repeat_all: 'fa-sync-alt', shuffle: 'fa-random' };

        function normalizePlayMode(value) {
            if (value === 'random') return 'shuffle';
            if (value === 'single') return 'repeat_one';
            return PLAY_MODES.includes(value) ? value : 'shuffle';
        }

        function updatePlayModeUI() {
            playMode = normalizePlayMode(playMode);
            const label = PLAY_MODE_LABELS[playMode];
            const icon = PLAY_MODE_ICONS[playMode];
            const btn = document.getElementById('playModeBtn');
            if (btn) {
                btn.innerHTML = '<i class="fas ' + icon + ' text-lg" aria-hidden="true"></i>';
                btn.title = label;
                btn.setAttribute('aria-label', '切换播放模式，当前' + label);
            }
            const mobileBtn = document.getElementById('mobileModeBtn');
            if (mobileBtn) {
                mobileBtn.innerHTML = '<i class="fas ' + icon + ' text-xl" aria-hidden="true"></i>';
                mobileBtn.title = label;
                mobileBtn.setAttribute('aria-label', '切换播放模式，当前' + label);
            }
        }

        function setPlayMode(value, options) {
            options = options || {};
            playMode = normalizePlayMode(value);
            if (playMode === 'shuffle' && options.shuffle !== false && typeof shufflePlaylist === 'function') {
                shufflePlaylist();
            }
            writeLocalStorage('cp_play_mode', playMode);
            updatePlayModeUI();
            if (options.refresh !== false) {
                if (typeof renderAllPlaylistItems === 'function' && dom.playlistContent) renderAllPlaylistItems();
                if (typeof mobileUI !== 'undefined' && mobileUI && typeof mobileUI.loadPlaylist === 'function') mobileUI.loadPlaylist();
                if (typeof highlightCurrentSong === 'function' && dom.playlistContent) highlightCurrentSong();
            }
            if (typeof scheduleSaveCurrentQueue === 'function') scheduleSaveCurrentQueue('play_mode');
            if (options.notify && typeof showToast === 'function') showToast('播放模式: ' + PLAY_MODE_LABELS[playMode]);
        }

        function cyclePlayMode() {
            const idx = PLAY_MODES.indexOf(normalizePlayMode(playMode));
            setPlayMode(PLAY_MODES[(idx + 1) % PLAY_MODES.length], { notify: true });
            try { console.log('[playMode]', playMode); } catch (e) {}
        }
        window.cyclePlayMode = cyclePlayMode;
        window.setPlayMode = setPlayMode;
        window.updatePlayModeUI = updatePlayModeUI;

        let parsedLyrics = [], activeLyricIndex = -1;

        // 伪随机播放：打乱后的播放顺序索引
        let shuffledOrder = [];  // 打乱后的索引顺序
        let shuffledIndex = 0;   // 当前在 shuffledOrder 中的位置
        let playbackAttemptCounter = 0;
        let activePlaybackAttempt = null;
        let committedMedia = null;
        const PLAYBACK_DIAGNOSTICS_LIMIT = 32;
        const PLAYBACK_DIAGNOSTIC_SOURCES = new Set(['load', 'play', 'media', 'resume']);
        const PLAYBACK_DIAGNOSTIC_CATEGORIES = new Set([
            'autoplay_blocked', 'interrupted', 'offline', 'auth', 'service', 'unavailable', 'unknown'
        ]);
        const PLAYBACK_DIAGNOSTIC_ERROR_NAMES = new Set([
            'AbortError', 'Error', 'MediaError', 'NotAllowedError', 'NotSupportedError',
            'TimeoutError', 'TypeError'
        ]);
        const PLAYBACK_DIAGNOSTIC_LABELS = Object.freeze({
            autoplay_blocked: '自动播放被阻止',
            interrupted: '播放请求被中断',
            offline: '网络断开',
            auth: 'API 鉴权失败',
            service: '服务或网络故障',
            unavailable: '音源不可用',
            unknown: '未知播放故障'
        });
        const PLAYBACK_DIAGNOSTIC_SOURCE_LABELS = Object.freeze({
            load: '加载音源',
            play: '启动播放',
            media: '媒体元素',
            resume: '恢复播放'
        });
        let playbackDiagnostics = [];
        let visualizerController = null;
        const reducedMotionQuery = typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : null;
        const mobileLayoutQuery = typeof window.matchMedia === 'function'
            ? window.matchMedia('(max-width: 767px), (max-width: 900px) and (max-height: 500px) and (orientation: landscape)')
            : null;
        let reducedMotionListenerBound = false;

        function normalizePlaybackDiagnosticErrorName(error) {
            const name = error && typeof error.name === 'string' ? error.name : '';
            return PLAYBACK_DIAGNOSTIC_ERROR_NAMES.has(name) ? name : (name ? 'OtherError' : 'UnknownError');
        }

        function getPlaybackDiagnosticMediaErrorCode() {
            const code = Number(audio && audio.error && audio.error.code);
            return Number.isInteger(code) && code >= 1 && code <= 4 ? code : null;
        }

        function recordPlaybackDiagnostic({ attempt, error, source, category }) {
            const safeSource = PLAYBACK_DIAGNOSTIC_SOURCES.has(source) ? source : 'load';
            const safeCategory = PLAYBACK_DIAGNOSTIC_CATEGORIES.has(category) ? category : 'unknown';
            const attemptIndex = attempt && Number.isInteger(attempt.index) && attempt.index >= 0
                ? attempt.index
                : (Number.isInteger(currentIndex) && currentIndex >= 0 ? currentIndex : null);
            const retryCount = attempt && attempt.failedIndexes instanceof Set
                ? attempt.failedIndexes.size
                : 0;
            const visibility = ['visible', 'hidden', 'prerender'].includes(document.visibilityState)
                ? document.visibilityState
                : 'unknown';
            const entry = Object.freeze({
                at: new Date().toISOString(),
                category: safeCategory,
                source: safeSource,
                errorName: normalizePlaybackDiagnosticErrorName(error),
                mediaErrorCode: getPlaybackDiagnosticMediaErrorCode(),
                mode: PLAY_MODES.includes(playMode) ? playMode : 'unknown',
                queueIndex: attemptIndex,
                visibility,
                online: navigator.onLine !== false,
                retryCount
            });
            playbackDiagnostics = playbackDiagnostics.concat(entry).slice(-PLAYBACK_DIAGNOSTICS_LIMIT);
            renderPlaybackDiagnostics();
            return entry;
        }

        function getCPlayerPlaybackDiagnostics() {
            return playbackDiagnostics.map(function (entry) { return Object.assign({}, entry); });
        }

        function clearCPlayerPlaybackDiagnostics() {
            playbackDiagnostics = [];
            renderPlaybackDiagnostics();
        }

        function renderPlaybackDiagnostics() {
            const list = document.getElementById('playbackDiagnosticsList');
            const status = document.getElementById('playbackDiagnosticsStatus');
            const clearButton = document.getElementById('clearPlaybackDiagnosticsBtn');
            if (!list) return;
            list.replaceChildren();
            if (status) status.textContent = playbackDiagnostics.length
                ? '当前页面暂存最近 ' + playbackDiagnostics.length + ' 条故障记录'
                : '暂无播放故障记录';
            if (clearButton) clearButton.disabled = playbackDiagnostics.length === 0;
            if (!playbackDiagnostics.length) {
                const empty = document.createElement('div');
                empty.className = 'text-xs opacity-45';
                empty.textContent = '播放正常时这里不会显示内容';
                list.appendChild(empty);
                return;
            }
            playbackDiagnostics.slice().reverse().forEach(function (entry) {
                const item = document.createElement('div');
                item.className = 'p-3 rounded-xl bg-black/15 border border-white/5';
                const title = document.createElement('div');
                title.className = 'text-xs font-semibold';
                let timeText = entry.at;
                try { timeText = new Date(entry.at).toLocaleString('zh-CN', { hour12: false }); } catch (error) {}
                title.textContent = timeText + ' · ' + (PLAYBACK_DIAGNOSTIC_LABELS[entry.category] || '播放故障');
                const detail = document.createElement('div');
                detail.className = 'mt-1 text-[11px] opacity-55 break-words';
                const queueText = Number.isInteger(entry.queueIndex) ? '队列第 ' + (entry.queueIndex + 1) + ' 首' : '队列位置未知';
                const mediaText = entry.mediaErrorCode ? '媒体错误码 ' + entry.mediaErrorCode : '无媒体错误码';
                detail.textContent = [
                    PLAYBACK_DIAGNOSTIC_SOURCE_LABELS[entry.source] || '播放流程',
                    entry.errorName,
                    PLAY_MODE_LABELS[entry.mode] || '播放模式未知',
                    queueText,
                    entry.visibility === 'hidden' ? '页面隐藏' : '页面可见',
                    entry.online ? '在线' : '离线',
                    mediaText,
                    '重试 ' + entry.retryCount + ' 次'
                ].join(' · ');
                item.appendChild(title);
                item.appendChild(detail);
                list.appendChild(item);
            });
        }

        window.getCPlayerPlaybackDiagnostics = getCPlayerPlaybackDiagnostics;
        window.clearCPlayerPlaybackDiagnostics = clearCPlayerPlaybackDiagnostics;

        // ================= IndexedDB 缓存系统 =================
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 6;
        const CLOUD_OUTBOX_STORE = 'cloud_outbox';
        const PLAYLIST_HISTORY_STORE = 'playlist_versions';
        const IMAGE_CACHE_LIMIT = 160;
        const REMOTE_PLAYLIST_CACHE_LIMIT = 12;
        let db = null;
        let databaseOpenPromise = null;

        async function initDatabase() {
            if (db) return db;
            if (databaseOpenPromise) return databaseOpenPromise;
            if (storageState === 'blocked' || storageState === 'stale') {
                const error = new Error(storageState === 'blocked'
                    ? 'IndexedDB upgrade remains blocked'
                    : 'IndexedDB connection is stale');
                error.name = storageState === 'blocked' ? 'StorageBlockedError' : 'VersionError';
                throw error;
            }

            const pending = new Promise((resolve, reject) => {
                let request;
                let settled = false;
                const settle = function (callback, value) {
                    if (settled) return false;
                    settled = true;
                    callback(value);
                    return true;
                };

                try {
                    request = indexedDB.open(DB_NAME, DB_VERSION);
                } catch (error) {
                    setStorageState('degraded', STORAGE_WARNING, error);
                    settle(reject, error);
                    return;
                }

                request.onerror = () => {
                    const error = request.error || new Error('IndexedDB 打开失败');
                    const state = error && error.name === 'VersionError' ? 'stale' : 'degraded';
                    const message = state === 'stale'
                        ? '播放器数据已在其他页面升级，请刷新当前页面'
                        : STORAGE_WARNING;
                    setStorageState(state, message, error);
                    settle(reject, error);
                };
                request.onblocked = () => {
                    const error = new Error('IndexedDB upgrade blocked by another page');
                    error.name = 'StorageBlockedError';
                    setStorageState('blocked', '存储升级被其他播放器页面占用，请关闭其他页面后刷新', error);
                    settle(reject, error);
                };
                request.onsuccess = () => {
                    const connection = request.result;
                    if (settled) {
                        connection.close();
                        return;
                    }
                    connection.onversionchange = () => {
                        connection.close();
                        if (db === connection) db = null;
                        databaseOpenPromise = null;
                        setStorageState('stale', '播放器数据已在其他页面升级，请刷新当前页面');
                    };
                    connection.onclose = () => {
                        if (db === connection) {
                            db = null;
                            if (storageState !== 'stale') {
                                setStorageState('degraded', STORAGE_WARNING);
                            }
                        }
                    };
                    db = connection;
                    setStorageState('ready');
                    settle(resolve, connection);
                    void pruneTransientCaches(false).catch((error) => {
                        console.warn('[storage] background cache pruning failed', error);
                    });
                };

                request.onupgradeneeded = (event) => {
                    const database = event.target.result;
                    const upgradeTx = event.target.transaction;

                    // 歌单缓存表
                    if (!database.objectStoreNames.contains('playlists')) {
                        const playlistStore = database.createObjectStore('playlists', { keyPath: 'id' });
                        playlistStore.createIndex('timestamp', 'timestamp');
                    }

                    // 歌词缓存表
                    if (!database.objectStoreNames.contains('lyrics')) {
                        database.createObjectStore('lyrics', { keyPath: 'songId' });
                    }

                    // 图片缓存表
                    let imageStore;
                    if (!database.objectStoreNames.contains('images')) {
                        imageStore = database.createObjectStore('images', { keyPath: 'url' });
                    } else {
                        imageStore = upgradeTx.objectStore('images');
                    }
                    if (!imageStore.indexNames.contains('timestamp')) {
                        imageStore.createIndex('timestamp', 'timestamp');
                    }
                    const legacyCursor = imageStore.openCursor();
                    legacyCursor.onsuccess = function () {
                        const cursor = legacyCursor.result;
                        if (!cursor) return;
                        const value = cursor.value;
                        if (!Number.isFinite(Number(value.timestamp))) {
                            value.timestamp = 0;
                            cursor.update(value);
                        }
                        cursor.continue();
                    };

                    let outboxStore;
                    if (!database.objectStoreNames.contains(CLOUD_OUTBOX_STORE)) {
                        outboxStore = database.createObjectStore(CLOUD_OUTBOX_STORE, { keyPath: 'id' });
                    } else {
                        outboxStore = upgradeTx.objectStore(CLOUD_OUTBOX_STORE);
                    }
                    if (!outboxStore.indexNames.contains('ownerId')) {
                        outboxStore.createIndex('ownerId', 'ownerId');
                    }
                    if (!outboxStore.indexNames.contains('updatedAt')) {
                        outboxStore.createIndex('updatedAt', 'updatedAt');
                    }

                    let historyStore;
                    if (!database.objectStoreNames.contains(PLAYLIST_HISTORY_STORE)) {
                        historyStore = database.createObjectStore(PLAYLIST_HISTORY_STORE, { keyPath: 'id' });
                    } else {
                        historyStore = upgradeTx.objectStore(PLAYLIST_HISTORY_STORE);
                    }
                    if (!historyStore.indexNames.contains('playlistId')) {
                        historyStore.createIndex('playlistId', 'playlistId');
                    }
                    if (!historyStore.indexNames.contains('createdAt')) {
                        historyStore.createIndex('createdAt', 'createdAt');
                    }
                    if (!historyStore.indexNames.contains('cloudOwnerId')) {
                        historyStore.createIndex('cloudOwnerId', 'cloudOwnerId');
                    }
                };
            });

            const tracked = pending.finally(() => {
                if (databaseOpenPromise === tracked) databaseOpenPromise = null;
            });
            databaseOpenPromise = tracked;
            return tracked;
        }

        function transactionDone(tx) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = function (callback, value) {
                    if (settled) return;
                    settled = true;
                    callback(value);
                };
                tx.addEventListener('complete', () => finish(resolve));
                tx.addEventListener('error', (event) => {
                    const requestError = event && event.target && event.target !== tx
                        ? event.target.error
                        : null;
                    finish(reject, requestError || tx.error || new Error('数据库事务失败'));
                });
                tx.addEventListener('abort', () => finish(reject, tx.error || new Error('数据库事务中断')));
            });
        }

        function isQuotaExceededError(error) {
            let current = error;
            for (let depth = 0; current && depth < 4; depth += 1) {
                if (current.name === 'QuotaExceededError' || /quota|存储空间/i.test(String(current.message || ''))) return true;
                current = current.cause;
            }
            return false;
        }

        async function pruneIndexedCache(storeName, indexName, limit, shouldInclude, aggressive) {
            if (!db || !db.objectStoreNames.contains(storeName)) return;
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const index = store.index(indexName);
            let kept = 0;
            const request = index.openCursor(null, 'prev');
            request.onsuccess = function () {
                const cursor = request.result;
                if (!cursor) return;
                if (!shouldInclude || shouldInclude(cursor.value)) {
                    if (aggressive || kept >= limit) cursor.delete();
                    else kept += 1;
                }
                cursor.continue();
            };
            await transactionDone(tx);
        }

        async function pruneTransientCaches(aggressive) {
            if (!db) return;
            const failures = [];
            try {
                await pruneIndexedCache('images', 'timestamp', IMAGE_CACHE_LIMIT, null, aggressive);
            } catch (error) {
                failures.push(error);
            }
            try {
                await pruneIndexedCache('playlists', 'timestamp', REMOTE_PLAYLIST_CACHE_LIMIT, function (record) {
                    if (!record || record.id == null) return false;
                    const id = String(record.id);
                    return id !== CURRENT_QUEUE_KEY && id.indexOf(USER_PL_PREFIX) !== 0;
                }, aggressive);
            } catch (error) {
                failures.push(error);
            }
            if (failures.length) throw failures[0];
        }

        async function runCriticalStorageWrite(operation) {
            try {
                return await operation();
            } catch (error) {
                if (!isQuotaExceededError(error)) throw error;
                try {
                    await pruneTransientCaches(true);
                } catch (pruneError) {
                    console.warn('[storage] quota cleanup failed', pruneError);
                }
                return operation();
            }
        }

        async function handleOptionalCacheFailure(label, error) {
            console.warn('[storage] ' + label + ' cache failed', error);
            if (isQuotaExceededError(error)) {
                try {
                    await pruneTransientCaches(true);
                    setStorageState('degraded', '浏览器缓存空间不足，已清理临时缓存', error);
                } catch (pruneError) {
                    console.warn('[storage] optional cache cleanup failed', pruneError);
                    setStorageState('degraded', '浏览器缓存空间不足，临时缓存清理失败，请刷新后重试', pruneError);
                }
            } else {
                setStorageState('degraded', STORAGE_WARNING, error);
            }
        }

        // ================= 歌单小图缓存逻辑（仅用于列表缩略图） =================
        window.getCachedImage = async function (url) {
            if (!url || !db) return url;

            // 安全检查：确保 images 表存在
            if (!db.objectStoreNames.contains('images')) {
                return url;
            }

            const secureUrl = url.replace(/^http:/, 'https:');
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction('images', 'readonly');
                    const store = tx.objectStore('images');
                    const req = store.get(secureUrl);
                    req.onsuccess = () => {
                        if (req.result && req.result.data) {
                            resolve(req.result.data); // 命中缓存
                        } else {
                            // 未命中 — 加载图片并缩小到 80x80 存入缓存
                            const img = new Image();
                            img.crossOrigin = 'Anonymous';
                            img.onload = () => {
                                try {
                                    const THUMB_SIZE = 80;
                                    const canvas = document.createElement('canvas');
                                    canvas.width = THUMB_SIZE;
                                    canvas.height = THUMB_SIZE;
                                    const ctx = canvas.getContext('2d');
                                    ctx.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE);
                                    const base64 = canvas.toDataURL('image/jpeg', 0.7);

                                    // 写入缓存
                                    const writeTx = db.transaction('images', 'readwrite');
                                    writeTx.objectStore('images').put({ url: secureUrl, data: base64, timestamp: Date.now() });
                                    transactionDone(writeTx).then(function () {
                                        return pruneIndexedCache('images', 'timestamp', IMAGE_CACHE_LIMIT, null, false);
                                    }).catch(function (error) {
                                        void handleOptionalCacheFailure('image', error);
                                    });
                                    resolve(base64);
                                } catch (e) {
                                    void handleOptionalCacheFailure('image', e);
                                    resolve(secureUrl); // 降级
                                }
                            };
                            img.onerror = () => resolve(secureUrl);
                            img.src = secureUrl;
                        }
                    };
                    req.onerror = () => resolve(secureUrl);
                } catch (e) {
                    console.warn('Image cache transaction failed:', e);
                    resolve(secureUrl);
                }
            });
        };

        // 保存歌单到 IndexedDB
        async function savePlaylistToCache(playlistId, songs) {
            if (!db) return false;
            try {
                const tx = db.transaction('playlists', 'readwrite');
                const store = tx.objectStore('playlists');
                store.put({
                    id: playlistId,
                    songs: songs,
                    timestamp: Date.now()
                });
                await transactionDone(tx);
                await pruneIndexedCache('playlists', 'timestamp', REMOTE_PLAYLIST_CACHE_LIMIT, function (record) {
                    if (!record || record.id == null) return false;
                    const id = String(record.id);
                    return id !== CURRENT_QUEUE_KEY && id.indexOf(USER_PL_PREFIX) !== 0;
                }, false);
                return true;
            } catch (error) {
                await handleOptionalCacheFailure('playlist', error);
                return false;
            }
        }

        // 从 IndexedDB 获取歌单
        async function getPlaylistFromCache(playlistId) {
            if (!db) return null;
            return new Promise((resolve, reject) => {
                let tx;
                let value = null;
                let requestError = null;
                try {
                    tx = db.transaction('playlists', 'readonly');
                    const store = tx.objectStore('playlists');
                    const request = store.get(playlistId);
                    request.onsuccess = () => { value = request.result || null; };
                    request.onerror = () => { requestError = request.error; };
                } catch (error) {
                    reject(error);
                    return;
                }
                transactionDone(tx).then(() => resolve(value), (error) => reject(requestError || error));
            });
        }

        // ===== Local queue + user playlists (minimal, stable) =====
        const CURRENT_QUEUE_KEY = 'current_queue';
        const USER_PL_PREFIX = 'user_pl_';
        const RECENT_HISTORY_KEY = 'cp_recent_history';
        const PLAYBACK_SESSION_KEY = 'cp_playback_session';
        const SLEEP_TIMER_KEY = 'cp_sleep_timer_end_at';
        const RECENT_HISTORY_LIMIT = 50;
        const PLAYLIST_BACKUP_FORMAT = 'cplayer-playlists-backup';
        const PLAYLIST_BACKUP_VERSION = 1;
        const PLAYLIST_BACKUP_MAX_BYTES = 5 * 1024 * 1024;
        const PLAYLIST_BACKUP_MAX_PLAYLISTS = 500;
        const PLAYLIST_BACKUP_MAX_SONGS = 10000;
        const RECOVERY_PACKAGE_FORMAT = 'cplayer-recovery-package';
        const RECOVERY_PACKAGE_VERSION = 1;
        const RECOVERY_PACKAGE_MAX_HISTORY = PLAYLIST_BACKUP_MAX_PLAYLISTS * 20;
        const QUEUE_WRITER_ID = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : 'queue-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        let queueSaveTimer = null;
        let queueSaveInFlight = null;
        let queueSavePendingReason = '';
        let queueBaseRevision = 0;
        let queueWriteBlocked = false;
        let suppressQueueAutosave = false;
        let pendingSongForPlaylist = null;
        let pendingPlaybackSession = null;
        let playbackSessionLastSavedAt = 0;
        let sleepTimerEndAt = 0;
        let sleepTimerTimeout = null;
        let sleepTimerInterval = null;
        let cloudService = null;
        let cloudSession = null;
        let cloudUserId = '';
        let cloudAuthSubscription = null;
        let cloudAccountBusy = false;
        let cloudRecoveryMode = false;
        let cloudState = 'disabled';
        let cloudStateMessage = '云同步尚未配置，播放器仍可本地使用';
        let cloudSyncTimer = null;
        let cloudSyncInFlight = null;
        let cloudSyncPendingReason = '';
        let cloudPendingCount = 0;
        let cloudPendingItems = [];
        let cloudPendingReadToken = 0;
        let cloudLastSuccessfulAt = 0;
        let cloudLastErrorMessage = '';
        const cloudConflicts = new Map();
        const CLOUD_DETACH_PENDING_KEY = 'cp_cloud_detach_pending';
        const CLOUD_LAST_SUCCESS_KEY = 'cp_cloud_last_success';
        const CLOUD_LAST_ERROR_KEY = 'cp_cloud_last_error';

        document.documentElement.dataset.cplayerCloudState = cloudState;

        function readPlaybackSession() {
            try {
                const raw = readLocalStorage(PLAYBACK_SESSION_KEY);
                if (!raw) return null;
                const normalized = normalizePlaybackSession(JSON.parse(raw));
                if (!normalized) removeLocalStorage(PLAYBACK_SESSION_KEY);
                return normalized;
            } catch (error) {
                removeLocalStorage(PLAYBACK_SESSION_KEY);
                console.warn('[resume] invalid playback session ignored', error);
                return null;
            }
        }

        function clearPlaybackSession() {
            pendingPlaybackSession = null;
            removeLocalStorage(PLAYBACK_SESSION_KEY);
        }

        function getQueueSongId(index) {
            if (!Number.isInteger(index) || index < 0 || index >= playlist.length) return '';
            const song = playlist[index];
            const songId = typeof song === 'object' ? song.id : song;
            return songId == null ? '' : String(songId);
        }

        function normalizeMediaSource(value) {
            if (!value) return '';
            try { return new URL(String(value), window.location.href).href; } catch (error) { return ''; }
        }

        function getMainAudioSource() {
            return normalizeMediaSource(audio.src || audio.currentSrc || '');
        }

        function isCommittedMediaCurrent() {
            return !!(committedMedia && committedMedia.source &&
                getMainAudioSource() === committedMedia.source);
        }

        function isAttemptCommitted(attempt) {
            return !!(attempt && committedMedia &&
                committedMedia.token === attempt.token && isCommittedMediaCurrent());
        }

        function commitMediaIdentity(attempt, source) {
            if (!committedMedia || committedMedia.songId !== String(attempt.songId)) clearPlaybackSession();
            committedMedia = {
                token: attempt.token,
                songId: String(attempt.songId),
                source: normalizeMediaSource(source),
                ready: false,
                endedHandled: false
            };
            clearMediaSessionPositionState();
        }

        function markCommittedMediaReady() {
            if (!committedMedia || !isCommittedMediaCurrent()) return false;
            committedMedia.ready = true;
            return true;
        }

        function savePlaybackSession(reason, force) {
            const now = Date.now();
            if (!force && now - playbackSessionLastSavedAt < 5000) return false;
            if (!committedMedia || !committedMedia.ready || !isCommittedMediaCurrent()) return false;
            const songId = committedMedia.songId;
            const mediaIndex = resolvePlaylistIndexBySongId(songId);
            const currentTime = Number(audio.currentTime);
            const duration = Number(audio.duration);
            const safeCurrentTime = getSafePlaybackResumeTime(currentTime, duration);
            if (!songId || mediaIndex < 0 ||
                !safeCurrentTime) {
                return false;
            }
            const payload = {
                version: PLAYBACK_SESSION_VERSION,
                songId,
                currentIndex: mediaIndex,
                currentTime: safeCurrentTime,
                duration,
                wasPlaying: !audio.paused && !audio.ended,
                updatedAt: now,
                reason: reason || 'auto'
            };
            if (!writeLocalStorage(PLAYBACK_SESSION_KEY, JSON.stringify(payload))) return false;
            playbackSessionLastSavedAt = now;
            return true;
        }

        function preparePlaybackResume() {
            pendingPlaybackSession = readPlaybackSession();
            if (!pendingPlaybackSession || !playlist.length) return false;
            const matchIndex = playlist.findIndex(function (song) {
                const songId = typeof song === 'object' ? song.id : song;
                return String(songId) === pendingPlaybackSession.songId;
            });
            if (matchIndex < 0) {
                clearPlaybackSession();
                return false;
            }
            currentIndex = matchIndex;
            scheduleSaveCurrentQueue('resume_prepare');
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
            if (typeof showToast === 'function') {
                showToast('已找回上次进度 ' + formatTime(pendingPlaybackSession.currentTime) + '，点击播放继续');
            }
            return true;
        }

        function getPlaybackResumeTime(index) {
            if (!pendingPlaybackSession) return 0;
            return getQueueSongId(index) === pendingPlaybackSession.songId
                ? pendingPlaybackSession.currentTime
                : 0;
        }

        function formatSleepTimerRemaining(remainingMs) {
            const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
            if (totalMinutes < 60) return totalMinutes + ' 分钟';
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            return minutes ? hours + ' 小时 ' + minutes + ' 分钟' : hours + ' 小时';
        }

        function updateSleepTimerUI() {
            const status = document.getElementById('sleepTimerStatus');
            const select = document.getElementById('sleepTimerSelect');
            const button = document.getElementById('sleepTimerBtn');
            const remaining = getSleepTimerRemainingMs(sleepTimerEndAt);
            if (status) status.textContent = remaining ? '剩余 ' + formatSleepTimerRemaining(remaining) : '未设置';
            if (button) button.textContent = remaining ? '取消' : '设置';
            if (!remaining && select) select.value = '0';
        }

        function clearSleepTimer(options) {
            options = options || {};
            if (sleepTimerTimeout) clearTimeout(sleepTimerTimeout);
            if (sleepTimerInterval) clearInterval(sleepTimerInterval);
            sleepTimerTimeout = null;
            sleepTimerInterval = null;
            sleepTimerEndAt = 0;
            removeLocalStorage(SLEEP_TIMER_KEY);
            updateSleepTimerUI();
            if (options.notify && typeof showToast === 'function') showToast('睡眠定时已取消');
        }

        function handleSleepTimerExpired() {
            try { audio.pause(); } catch (error) {}
            savePlaybackSession('sleep_timer', true);
            clearSleepTimer();
            if (typeof showToast === 'function') showToast('睡眠定时到点，已暂停播放');
        }

        function scheduleSleepTimer() {
            if (sleepTimerTimeout) clearTimeout(sleepTimerTimeout);
            if (sleepTimerInterval) clearInterval(sleepTimerInterval);
            const remaining = getSleepTimerRemainingMs(sleepTimerEndAt);
            if (!remaining) {
                clearSleepTimer();
                return false;
            }
            sleepTimerTimeout = setTimeout(handleSleepTimerExpired, remaining);
            sleepTimerInterval = setInterval(updateSleepTimerUI, 1000);
            updateSleepTimerUI();
            return true;
        }

        function setSleepTimer(minutes) {
            const value = Number(minutes);
            if (!Number.isFinite(value) || value <= 0) {
                clearSleepTimer({ notify: true });
                return;
            }
            sleepTimerEndAt = Date.now() + value * 60000;
            writeLocalStorage(SLEEP_TIMER_KEY, String(sleepTimerEndAt));
            scheduleSleepTimer();
            if (typeof showToast === 'function') showToast('睡眠定时已设置：' + value + ' 分钟');
        }

        function setupSleepTimerUI() {
            const select = document.getElementById('sleepTimerSelect');
            const button = document.getElementById('sleepTimerBtn');
            if (!select || !button || button.dataset.bound === '1') return;
            button.dataset.bound = '1';
            button.addEventListener('click', function () {
                if (getSleepTimerRemainingMs(sleepTimerEndAt)) {
                    clearSleepTimer({ notify: true });
                    return;
                }
                if (Number(select.value) <= 0) {
                    if (typeof showToast === 'function') showToast('请先选择定时时长', true);
                    return;
                }
                setSleepTimer(select.value);
            });
            sleepTimerEndAt = Number(readLocalStorage(SLEEP_TIMER_KEY, '0')) || 0;
            if (getSleepTimerRemainingMs(sleepTimerEndAt)) scheduleSleepTimer();
            else clearSleepTimer();
        }

        // API 密钥/地址设置：只绑定按钮到 saveApiSettings/resetApiSettings。
        // 实际读写逻辑集中在那两个函数里（含地址校验与本地存储）。
        function setupApiSettingsUI() {
            const saveBtn = document.getElementById('settingsApiSaveBtn');
            const resetBtn = document.getElementById('settingsApiResetBtn');
            if (!saveBtn || saveBtn.dataset.bound === '1') return;
            saveBtn.dataset.bound = '1';
            saveBtn.addEventListener('click', function () {
                if (typeof saveApiSettings === 'function') saveApiSettings();
            });
            if (resetBtn) {
                resetBtn.addEventListener('click', function () {
                    if (typeof resetApiSettings === 'function') resetApiSettings();
                });
            }
        }

        function setupPlaybackDiagnosticsUI() {
            const clearButton = document.getElementById('clearPlaybackDiagnosticsBtn');
            if (clearButton && clearButton.dataset.bound !== '1') {
                clearButton.dataset.bound = '1';
                clearButton.addEventListener('click', function () {
                    clearCPlayerPlaybackDiagnostics();
                    if (typeof showToast === 'function') showToast('已清除本机播放诊断');
                });
            }
            renderPlaybackDiagnostics();
        }

        function normalizeCloudVersion(value) {
            const version = Number(value);
            return Number.isSafeInteger(version) && version >= 0 ? version : 0;
        }

        function normalizeLocalCloudFields(record) {
            record = record || {};
            return {
                cloudOwnerId: typeof record.cloudOwnerId === 'string' ? record.cloudOwnerId : '',
                cloudVersion: normalizeCloudVersion(record.cloudVersion),
                cloudDirty: record.cloudDirty === true
            };
        }

        function normalizeLocalPlaylistState(record) {
            const deletedAt = Number(record && record.deletedAt);
            const purgedAt = Number(record && record.purgedAt);
            return {
                deletedAt: Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : 0,
                purgedAt: Number.isFinite(purgedAt) && purgedAt > 0 ? purgedAt : 0
            };
        }

        function makeCloudOwnerCollisionError() {
            const error = new Error('本机已有其他账号的同 ID 歌单');
            error.name = 'CloudOwnerCollisionError';
            return error;
        }

        function makeCloudPlaylistSnapshot(record) {
            const normalizedSongs = Array.isArray(record && record.songs)
                ? record.songs.map(normalizeSongObject).filter(function (song) {
                    return song && song.id != null && String(song.id).trim();
                })
                : [];
            return {
                id: String(record && record.id || ''),
                name: String(record && record.name || '未命名歌单').trim().slice(0, 100) || '未命名歌单',
                songs: normalizedSongs
            };
        }

        function makeCloudMutationId() {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
            return 'cloud-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        }

        function makeCloudOutboxRecord(ownerId, record, operation, expectedVersion, history) {
            const playlistId = String(record && (record.id || record.playlistId) || '');
            const base = {
                id: makeCloudOutboxId(ownerId, playlistId),
                ownerId: ownerId,
                playlistId: playlistId,
                operation: operation,
                mutationId: makeCloudMutationId(),
                expectedVersion: normalizeCloudVersion(expectedVersion),
                updatedAt: Date.now()
            };
            if (operation !== 'purge') base.playlist = makeCloudPlaylistSnapshot(record);
            if (operation !== 'purge' && Array.isArray(history) && history.length) {
                base.history = history.map(function (entry) {
                    const normalized = normalizePlaylistVersion(entry);
                    return {
                        id: normalized.id,
                        playlistId: normalized.playlistId,
                        name: normalized.name,
                        songs: normalized.songs,
                        createdAt: normalized.createdAt,
                        reason: normalized.reason,
                        snapshotId: normalized.snapshotId,
                        cloudOwnerId: ownerId
                    };
                });
            }
            return base;
        }

        function hasCloudOutboxStore() {
            return !!(db && db.objectStoreNames && db.objectStoreNames.contains(CLOUD_OUTBOX_STORE));
        }

        async function readCloudOutbox(ownerId) {
            if (!hasCloudOutboxStore()) return [];
            const requestedOwnerId = typeof ownerId === 'string' ? ownerId : '';
            return new Promise(function (resolve, reject) {
                let tx;
                let requestError = null;
                let records = [];
                try {
                    tx = db.transaction(CLOUD_OUTBOX_STORE, 'readonly');
                    const store = tx.objectStore(CLOUD_OUTBOX_STORE);
                    const request = requestedOwnerId && store.indexNames.contains('ownerId')
                        ? store.index('ownerId').getAll(IDBKeyRange.only(requestedOwnerId))
                        : store.getAll();
                    request.onsuccess = function () {
                        records = (request.result || []).filter(function (item) {
                            return item && (!requestedOwnerId || item.ownerId === requestedOwnerId);
                        });
                    };
                    request.onerror = function () { requestError = request.error; };
                } catch (error) {
                    reject(error);
                    return;
                }
                transactionDone(tx).then(function () {
                    resolve(records);
                }, function (error) {
                    reject(requestError || error);
                });
            });
        }

        function cloudPendingOperationLabel(operation) {
            if (operation === 'delete') return '移入回收站';
            if (operation === 'purge') return '永久删除';
            if (operation === 'restore') return '恢复歌单';
            return '修改歌单';
        }

        function formatCloudPendingUpdatedAt(value) {
            const timestamp = Number(value);
            if (!Number.isFinite(timestamp) || timestamp <= 0) return '更新时间未知';
            const date = new Date(timestamp);
            if (!Number.isFinite(date.getTime())) return '更新时间未知';
            return date.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        }

        function normalizeCloudPendingItem(record) {
            if (!record || typeof record.id !== 'string' || !record.id ||
                typeof record.playlistId !== 'string' || !record.playlistId) return null;
            const playlist = record.playlist && typeof record.playlist === 'object'
                ? record.playlist
                : null;
            const name = playlist && typeof playlist.name === 'string' && playlist.name.trim()
                ? playlist.name.trim().slice(0, 100)
                : '歌单 ' + record.playlistId;
            const songs = playlist && Array.isArray(playlist.songs) ? playlist.songs.length : null;
            return {
                id: record.id,
                playlistId: record.playlistId,
                operation: typeof record.operation === 'string' ? record.operation : 'upsert',
                name: name,
                songCount: Number.isSafeInteger(songs) && songs >= 0 ? songs : null,
                updatedAt: Number(record.updatedAt) || 0
            };
        }

        function setCloudPendingItems(records, ownerId) {
            if (!ownerId || cloudUserId !== ownerId) {
                cloudPendingItems = [];
                return;
            }
            cloudPendingItems = (Array.isArray(records) ? records : [])
                .map(normalizeCloudPendingItem)
                .filter(Boolean)
                .sort(function (a, b) {
                    return (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name);
                });
        }

        async function refreshCloudPendingCount(ownerId) {
            const requestedOwnerId = typeof ownerId === 'string' ? ownerId : '';
            const readToken = ++cloudPendingReadToken;
            try {
                const records = await readCloudOutbox(requestedOwnerId);
                if (readToken !== cloudPendingReadToken) return;
                if (requestedOwnerId) {
                    if (cloudUserId !== requestedOwnerId) return;
                } else if (cloudUserId) {
                    return;
                }
                setCloudPendingItems(records, requestedOwnerId);
                setCloudPendingCount(records.length);
            } catch (error) {
                if (readToken !== cloudPendingReadToken) return;
                const sameOwner = requestedOwnerId ? cloudUserId === requestedOwnerId : !cloudUserId;
                if (sameOwner) {
                    cloudPendingItems = [];
                    setCloudState('error', '无法读取待同步项目，本机数据仍保留', error);
                }
            }
        }

        function setCloudPendingCount(value) {
            const count = Number(value);
            const normalized = Number.isSafeInteger(count) && count >= 0 ? count : 0;
            const changed = normalized !== cloudPendingCount;
            cloudPendingReadToken += 1;
            cloudPendingCount = normalized;
            if (changed) invalidateCloudHealthSnapshot('待同步项目数量已变化');
            refreshCloudAccountUI();
        }

        async function readUserPlaylistRecords(options) {
            options = options || {};
            if (!db && typeof initDatabase === 'function') {
                try { await initDatabase(); } catch (e) {}
            }
            if (!db) {
                setStorageState(storageState === 'stale' ? 'stale' : 'degraded',
                    storageState === 'stale' ? '播放器数据已在其他页面升级，请刷新当前页面' : STORAGE_WARNING);
                const error = new Error('浏览器存储不可用，无法读取自建歌单');
                error.name = 'StorageUnavailableError';
                throw error;
            }
            const includeForeign = options.includeForeign === true;
            const includeTrash = options.includeTrash === true;
            const onlyTrash = options.onlyTrash === true;
            const includePurged = options.includePurged === true;
            const ownerId = options.ownerId || cloudUserId;
            const read = new Promise(function (resolve, reject) {
                let tx;
                let requestError = null;
                let all = [];
                try {
                    tx = db.transaction('playlists', 'readonly');
                    const store = tx.objectStore('playlists');
                    const request = store.getAll();
                    request.onsuccess = function () {
                        all = request.result || [];
                    };
                    request.onerror = function () { requestError = request.error; };
                } catch (error) {
                    reject(error);
                    return;
                }
                transactionDone(tx).then(function () {
                    const records = all.filter(function (item) {
                        if (!item || typeof item.id !== 'string' || item.id.indexOf(USER_PL_PREFIX) !== 0) return false;
                        const fields = normalizeLocalCloudFields(item);
                        if (!includeForeign && ownerId && fields.cloudOwnerId && fields.cloudOwnerId !== ownerId) return false;
                        const state = normalizeLocalPlaylistState(item);
                        if (state.purgedAt && !includePurged) return false;
                        if (onlyTrash && (!state.deletedAt || state.purgedAt)) return false;
                        if (!onlyTrash && state.deletedAt && !includeTrash) return false;
                        return true;
                    }).map(function (item) {
                        const fields = normalizeLocalCloudFields(item);
                        return {
                            id: item.id,
                            name: item.name || '未命名歌单',
                            songs: Array.isArray(item.songs) ? item.songs : [],
                            timestamp: item.timestamp || 0,
                            cloudOwnerId: fields.cloudOwnerId,
                            cloudVersion: fields.cloudVersion,
                            cloudDirty: fields.cloudDirty,
                            deletedAt: normalizeLocalPlaylistState(item).deletedAt,
                            purgedAt: normalizeLocalPlaylistState(item).purgedAt
                        };
                    }).sort(function (a, b) {
                        return (b.timestamp || 0) - (a.timestamp || 0);
                    });
                    resolve(records);
                }, function (error) {
                    reject(requestError || error);
                });
            });
            try {
                return await read;
            } catch (error) {
                setStorageState('degraded', STORAGE_WARNING, error);
                throw error;
            }
        }

        function readRecentHistory() {
            try {
                const raw = readLocalStorage(RECENT_HISTORY_KEY);
                if (!raw) return [];
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) return [];
                return parsed.map(function (item) {
                    const song = normalizeSongObject(item);
                    if (!song || song.id == null || !String(song.id).trim()) return null;
                    song.playedAt = Number.isFinite(item.playedAt) ? item.playedAt : 0;
                    return song;
                }).filter(Boolean).slice(0, RECENT_HISTORY_LIMIT);
            } catch (error) {
                console.warn('[recent] invalid history ignored', error);
                return [];
            }
        }

        function writeRecentHistory(items) {
            const safeItems = Array.isArray(items) ? items.slice(0, RECENT_HISTORY_LIMIT) : [];
            return writeLocalStorage(RECENT_HISTORY_KEY, JSON.stringify(safeItems));
        }

        function recordRecentPlay(song) {
            const normalized = normalizeSongObject(song);
            if (!normalized || normalized.id == null || !String(normalized.id).trim()) return;
            normalized.playedAt = Date.now();
            const songId = String(normalized.id);
            const history = readRecentHistory().filter(function (item) {
                return String(item.id) !== songId;
            });
            history.unshift(normalized);
            if (writeRecentHistory(history) && typeof refreshRecentHistory === 'function') {
                refreshRecentHistory();
            }
        }

        function clearRecentHistory() {
            removeLocalStorage(RECENT_HISTORY_KEY);
            if (typeof refreshRecentHistory === 'function') refreshRecentHistory();
        }

        function isSongInPlaylist(songId) {
            return playlist.some(s => String(typeof s === 'object' ? s.id : s) === String(songId));
        }

        function normalizeQueueRevision(value) {
            const revision = Number(value);
            return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
        }

        function commitQueuePayload(payload) {
            return new Promise(function (resolve, reject) {
                let tx;
                let failure = null;
                let nextRevision = null;
                try {
                    tx = db.transaction('playlists', 'readwrite');
                    const store = tx.objectStore('playlists');
                    const readRequest = store.get(CURRENT_QUEUE_KEY);
                    readRequest.onsuccess = function () {
                        try {
                            const latest = readRequest.result || null;
                            const latestRevision = normalizeQueueRevision(latest && latest.revision);
                            if (latestRevision > queueBaseRevision && (!latest || latest.writerId !== QUEUE_WRITER_ID)) {
                                failure = new Error('Queue was updated by another page');
                                failure.name = 'QueueConflictError';
                                tx.abort();
                                return;
                            }
                            nextRevision = Math.max(queueBaseRevision, latestRevision) + 1;
                            store.put(Object.assign({}, payload, {
                                revision: nextRevision,
                                writerId: QUEUE_WRITER_ID
                            }));
                        } catch (error) {
                            failure = error;
                            try { tx.abort(); } catch (abortError) {}
                        }
                    };
                    readRequest.onerror = function () {
                        failure = readRequest.error || new Error('队列读取失败');
                        try { tx.abort(); } catch (abortError) {}
                    };
                } catch (error) {
                    reject(error);
                    return;
                }

                transactionDone(tx).then(function () {
                    resolve(nextRevision);
                }).catch(function (error) {
                    reject(failure || error);
                });
            });
        }

        async function saveCurrentQueue(reason) {
            if (suppressQueueAutosave) return false;
            if (queueWriteBlocked) {
                setStorageState('conflict', '播放列表已在其他页面更新，请刷新后再操作');
                return false;
            }
            if (!db) {
                setStorageState(storageState === 'stale' ? 'stale' : 'degraded',
                    storageState === 'stale' ? '播放器数据已在其他页面升级，请刷新当前页面' : STORAGE_WARNING);
                return false;
            }
            if (queueSaveInFlight) {
                queueSavePendingReason = reason || 'auto';
                return queueSaveInFlight.then(function () { return true; }, function () { return false; });
            }

            const payload = {
                id: CURRENT_QUEUE_KEY,
                songs: Array.isArray(playlist) ? playlist.slice() : [],
                currentIndex: currentIndex,
                playMode: playMode,
                timestamp: Date.now(),
                reason: reason || 'auto'
            };
            const write = runCriticalStorageWrite(function () {
                return commitQueuePayload(payload);
            });
            queueSaveInFlight = write;
            let saved = false;
            try {
                queueBaseRevision = await write;
                writeLocalStorage('cp_queue_dirty', '1');
                saved = true;
            } catch (e) {
                console.warn('[queue] save failed', e);
                if (e && e.name === 'QueueConflictError') {
                    queueWriteBlocked = true;
                    queueSavePendingReason = '';
                    setStorageState('conflict', '播放列表已在其他页面更新，请刷新后再操作', e);
                } else {
                    const message = isQuotaExceededError(e)
                        ? '播放列表保存失败，浏览器存储空间不足'
                        : STORAGE_WARNING;
                    setStorageState('degraded', message, e);
                }
            } finally {
                queueSaveInFlight = null;
            }

            if (queueSavePendingReason && !suppressQueueAutosave && !queueWriteBlocked) {
                const nextReason = queueSavePendingReason;
                queueSavePendingReason = '';
                return saveCurrentQueue(nextReason);
            }
            return saved;
        }

        function scheduleSaveCurrentQueue(reason) {
            if (queueSaveTimer) clearTimeout(queueSaveTimer);
            queueSaveTimer = setTimeout(function () {
                queueSaveTimer = null;
                saveCurrentQueue(reason);
            }, 250);
        }

        function flushScheduledQueueSave(reason) {
            if (queueSaveTimer) {
                clearTimeout(queueSaveTimer);
                queueSaveTimer = null;
            }
            return saveCurrentQueue(reason || 'lifecycle');
        }

        document.addEventListener('visibilitychange', function () {
            syncVisualLifecycle();
            if (document.visibilityState === 'hidden') {
                flushScheduledQueueSave('visibility_hidden');
                savePlaybackSession('visibility_hidden', true);
            }
        });
        window.addEventListener('pagehide', function () {
            flushScheduledQueueSave('pagehide');
            savePlaybackSession('pagehide', true);
        });

        async function restoreCurrentQueue() {
            if (!db) return false;
            try {
                const cached = await getPlaylistFromCache(CURRENT_QUEUE_KEY);
                if (!cached || !Array.isArray(cached.songs)) return false;
                queueBaseRevision = normalizeQueueRevision(cached.revision);
                queueWriteBlocked = false;
                suppressQueueAutosave = true;
                playlist = cached.songs.map(normalizeSongObject).filter(function (song) {
                    return song && song.id != null && String(song.id).trim();
                });
                window.playlist = playlist;
                currentIndex = (typeof cached.currentIndex === 'number' && cached.currentIndex >= 0 && cached.currentIndex < playlist.length) ? cached.currentIndex : -1;
                if (cached.playMode) {
                    playMode = normalizePlayMode(cached.playMode);
                    writeLocalStorage('cp_play_mode', playMode);
                    updatePlayModeUI();
                }
                playlistTotalCount = playlist.length;
                allSongsLoaded = true;
                playlistSource = 'local_queue';
                playlistSourceName = '本地播放列表';
                if (playMode === 'shuffle' && typeof shufflePlaylist === 'function') shufflePlaylist();
                if (typeof initPlaylistView === 'function') initPlaylistView();
                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
                suppressQueueAutosave = false;
                return true;
            } catch (e) {
                suppressQueueAutosave = false;
                console.warn('[queue] restore failed', e);
                setStorageState(storageState === 'stale' ? 'stale' : 'degraded',
                    storageState === 'stale' ? '播放器数据已在其他页面升级，请刷新当前页面' : '播放列表恢复失败，请刷新后重试', e);
                return false;
            }
        }

        window.addSongToQueueOnly = function (song, opts) {
            opts = opts || {};
            const newSong = normalizeSongObject(song);
            if (!newSong || newSong.id == null) return -1;
            if (isSongInPlaylist(newSong.id) && !opts.allowDuplicate) {
                if (typeof showToast === 'function') showToast('已在播放列表中: ' + newSong.name);
                return playlist.findIndex(function (s) { return String(typeof s === 'object' ? s.id : s) === String(newSong.id); });
            }
            const idx = window.insertSongToPlaylist(newSong);
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
            scheduleSaveCurrentQueue('add_only');
            if (opts.toast !== false && typeof showToast === 'function') showToast('已加入播放列表: ' + newSong.name);
            return idx;
        };

        window.removeSongFromQueue = function (index, opts) {
            opts = opts || {};
            if (!Array.isArray(playlist) || index < 0 || index >= playlist.length) return false;
            const removed = playlist[index];
            const removedName = typeof removed === 'object' ? (removed.name || '歌曲') : String(removed);
            if (Array.isArray(shuffledOrder) && shuffledOrder.length) {
                const newOrder = [];
                for (let i = 0; i < shuffledOrder.length; i++) {
                    const v = shuffledOrder[i];
                    if (v === index) continue;
                    newOrder.push(v > index ? v - 1 : v);
                }
                shuffledOrder = newOrder;
            }
            playlist.splice(index, 1);
            window.playlist = playlist;
            playlistTotalCount = playlist.length;
            if (playlist.length === 0) {
                currentIndex = -1;
                resetPlaybackIdentity();
            } else if (currentIndex === index) {
                clearPlaybackSession();
                if (currentIndex >= playlist.length) currentIndex = playlist.length - 1;
                const next = playlist[currentIndex];
                const nextId = typeof next === 'object' ? next.id : next;
                if (typeof loadAndPlaySong === 'function') loadAndPlaySong(nextId, { index: currentIndex, reason: 'queue_remove' });
            } else if (currentIndex > index) {
                currentIndex -= 1;
            }
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
            scheduleSaveCurrentQueue('remove');
            if (opts.toast !== false && typeof showToast === 'function') showToast('已移除: ' + removedName);
            return true;
        };

        async function listUserPlaylists(options) {
            return readUserPlaylistRecords(options);
        }

        function hasPlaylistHistoryStore() {
            return !!(db && db.objectStoreNames && db.objectStoreNames.contains(PLAYLIST_HISTORY_STORE));
        }

        function makePlaylistVersionSnapshot(record, reason, ownerId) {
            const snapshot = makeCloudPlaylistSnapshot(record);
            const snapshotId = makeCloudMutationId();
            return {
                id: snapshotId,
                playlistId: snapshot.id,
                name: snapshot.name,
                songs: snapshot.songs,
                createdAt: Date.now(),
                reason: reason || 'edit',
                snapshotId: snapshotId,
                cloudOwnerId: ownerId || ''
            };
        }

        function retainValidPlaylistVersions(entries, now) {
            const valid = [];
            (Array.isArray(entries) ? entries : []).forEach(function (entry) {
                try { valid.push(normalizePlaylistVersion(entry)); } catch (error) {
                    console.warn('[playlist-history] invalid local snapshot ignored', error);
                }
            });
            return selectRetainedPlaylistVersions(valid, now);
        }

        function isPlaylistVersionInOwnerScope(entry, ownerId) {
            const requestedOwnerId = typeof ownerId === 'string' ? ownerId : '';
            const entryOwnerId = entry && typeof entry.cloudOwnerId === 'string'
                ? entry.cloudOwnerId
                : '';
            return requestedOwnerId
                ? !entryOwnerId || entryOwnerId === requestedOwnerId
                : !entryOwnerId;
        }

        function makeRemotePlaylistVersionStorageId(ownerId, playlistId, snapshotId) {
            return 'cloud-history:' + JSON.stringify([
                String(ownerId || ''),
                String(playlistId || ''),
                String(snapshotId || '')
            ]);
        }

        function reconcilePlaylistVersionStore(store, existing, retained, ownerId) {
            const retainedIds = new Set(retained.map(function (entry) { return entry.id; }));
            (Array.isArray(existing) ? existing : []).forEach(function (entry) {
                if (entry && entry.id && isPlaylistVersionInOwnerScope(entry, ownerId) &&
                    !retainedIds.has(entry.id)) store.delete(entry.id);
            });
            retained.forEach(function (entry) { store.put(entry); });
        }

        async function readPlaylistVersions(playlistId, options) {
            options = options || {};
            if (!db && typeof initDatabase === 'function') await initDatabase();
            if (!db || !hasPlaylistHistoryStore()) return [];
            const requestedOwnerId = typeof options.ownerId === 'string' ? options.ownerId : '';
            return new Promise(function (resolve, reject) {
                const tx = db.transaction(PLAYLIST_HISTORY_STORE, 'readonly');
                const store = tx.objectStore(PLAYLIST_HISTORY_STORE);
                const request = store.index('playlistId').getAll(IDBKeyRange.only(String(playlistId || '')));
                let entries = [];
                let requestError = null;
                request.onsuccess = function () {
                    entries = retainValidPlaylistVersions((request.result || []).filter(function (entry) {
                        return isPlaylistVersionInOwnerScope(entry, requestedOwnerId);
                    }), Date.now());
                };
                request.onerror = function () { requestError = request.error; };
                transactionDone(tx).then(function () { resolve(entries); }, function (error) {
                    reject(requestError || error);
                });
            });
        }

        async function mergeRemotePlaylistVersions(playlistId, ownerId, remoteEntries) {
            if (!db || !hasPlaylistHistoryStore()) return [];
            const tx = db.transaction(PLAYLIST_HISTORY_STORE, 'readwrite');
            const store = tx.objectStore(PLAYLIST_HISTORY_STORE);
            const request = store.index('playlistId').getAll(IDBKeyRange.only(playlistId));
            let retained = [];
            request.onsuccess = function () {
                const existing = request.result || [];
                const incoming = (Array.isArray(remoteEntries) ? remoteEntries : []).map(function (entry) {
                    const normalized = normalizePlaylistVersion(entry);
                    return Object.assign({}, normalized, {
                        id: makeRemotePlaylistVersionStorageId(ownerId, playlistId, normalized.snapshotId),
                        cloudOwnerId: ownerId
                    });
                });
                const incomingSnapshotIds = new Set(incoming.map(function (entry) { return entry.snapshotId; }));
                const scopedExisting = existing.filter(function (entry) {
                    if (!isPlaylistVersionInOwnerScope(entry, ownerId)) return false;
                    try {
                        return !incomingSnapshotIds.has(normalizePlaylistVersion(entry).snapshotId);
                    } catch (error) {
                        return true;
                    }
                });
                retained = retainValidPlaylistVersions(scopedExisting.concat(incoming), Date.now()).map(function (entry) {
                    return Object.assign({}, entry, { cloudOwnerId: entry.cloudOwnerId || ownerId });
                });
                reconcilePlaylistVersionStore(store, existing, retained, ownerId);
            };
            await transactionDone(tx);
            return retained;
        }

        async function loadPlaylistVersions(playlistId) {
            const records = await readUserPlaylistRecords({
                includeForeign: true,
                includeTrash: true,
                includePurged: true
            });
            const playlistRecord = records.find(function (record) { return record.id === playlistId; });
            if (!playlistRecord || playlistRecord.purgedAt) return [];
            const ownerId = normalizeLocalCloudFields(playlistRecord).cloudOwnerId;
            let local = await readPlaylistVersions(playlistId, { ownerId: ownerId });
            if (ownerId && ownerId === cloudUserId && cloudService && navigator.onLine !== false) {
                try {
                    const remote = await cloudService.listPlaylistVersions(playlistId);
                    local = await mergeRemotePlaylistVersions(playlistId, ownerId, remote);
                } catch (error) {
                    setCloudState('error', '云端历史加载失败，本机历史仍可用', error);
                }
            }
            return local;
        }

        async function saveUserPlaylistRecord(rec, options) {
            options = options || {};
            if (!db) throw new Error('数据库未就绪');
            const cloudFields = normalizeLocalCloudFields(rec || {});
            const ownerId = options.remote
                ? cloudFields.cloudOwnerId
                : (cloudFields.cloudOwnerId || cloudUserId || '');
            const cloudVersion = cloudFields.cloudVersion;
            const cloudDirty = options.remote ? false : !!ownerId;
            const localState = normalizeLocalPlaylistState(rec || {});
            let payload = {
                id: rec.id,
                name: rec.name || '未命名歌单',
                songs: Array.isArray(rec.songs) ? rec.songs : [],
                timestamp: options.preserveTimestamp && Number.isFinite(Number(rec.timestamp))
                    ? Number(rec.timestamp)
                    : Date.now(),
                cloudOwnerId: ownerId,
                cloudVersion: cloudVersion,
                cloudDirty: cloudDirty,
                deletedAt: options.operation === 'restore' ? 0 : localState.deletedAt,
                purgedAt: 0
            };
            let outbox = null;
            try {
                await runCriticalStorageWrite(async function () {
                    if (!hasPlaylistHistoryStore()) throw new Error('歌单历史存储未就绪');
                    if (!options.remote && ownerId && !hasCloudOutboxStore()) throw new Error('云同步存储未就绪');
                    const stores = ['playlists', PLAYLIST_HISTORY_STORE];
                    if (!options.remote && ownerId) stores.push(CLOUD_OUTBOX_STORE);
                    const tx = db.transaction(stores, 'readwrite');
                    const playlistStore = tx.objectStore('playlists');
                    const historyStore = tx.objectStore(PLAYLIST_HISTORY_STORE);
                    const existingRequest = playlistStore.get(payload.id);
                    const historyRequest = historyStore.index('playlistId').getAll(IDBKeyRange.only(payload.id));
                    let existingReady = false;
                    let historyReady = false;
                    let existing = null;
                    let history = [];
                    let wrote = false;
                    const write = function () {
                        if (wrote || !existingReady || !historyReady) return;
                        wrote = true;
                        const now = Date.now();
                        const scopedHistory = history.filter(function (entry) {
                            return isPlaylistVersionInOwnerScope(entry, ownerId);
                        });
                        const nextHistory = scopedHistory.slice();
                        const existingState = normalizeLocalPlaylistState(existing || {});
                        if (!options.remote && !options.skipHistory && existing && !existingState.purgedAt &&
                            !haveSamePlaylistContent(existing, payload)) {
                            nextHistory.push(makePlaylistVersionSnapshot(
                                existing,
                                options.historyReason || 'edit',
                                ownerId
                            ));
                        }
                        const retained = retainValidPlaylistVersions(nextHistory, now).map(function (entry) {
                            return Object.assign({}, entry, { cloudOwnerId: ownerId || entry.cloudOwnerId || '' });
                        });
                        reconcilePlaylistVersionStore(historyStore, history, retained, ownerId);
                        playlistStore.put(payload);
                        if (!options.remote && ownerId) {
                            outbox = makeCloudOutboxRecord(
                                ownerId,
                                payload,
                                options.operation || 'upsert',
                                cloudVersion,
                                retained
                            );
                            tx.objectStore(CLOUD_OUTBOX_STORE).put(outbox);
                        }
                    };
                    existingRequest.onsuccess = function () {
                        existing = existingRequest.result || null;
                        existingReady = true;
                        write();
                    };
                    historyRequest.onsuccess = function () {
                        history = historyRequest.result || [];
                        historyReady = true;
                        write();
                    };
                    existingRequest.onerror = historyRequest.onerror = function () {
                        try { tx.abort(); } catch (abortError) {}
                    };
                    await transactionDone(tx);
                });
            } catch (error) {
                setStorageState('degraded', isQuotaExceededError(error)
                    ? '歌单保存失败，浏览器存储空间不足'
                    : STORAGE_WARNING, error);
                throw error;
            }
            if (outbox) {
                setCloudState('pending', navigator.onLine === false
                    ? '歌单已保存在本机，联网后同步'
                    : '歌单有待同步的修改');
                scheduleCloudSync('playlist_save');
            }
            return payload;
        }

        function createUserPlaylistId(existingIds) {
            let id;
            do {
                id = USER_PL_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
            } while (existingIds && existingIds.has(id));
            if (existingIds) existingIds.add(id);
            return id;
        }

        function isPlainRecord(value) {
            return !!value && typeof value === 'object' && !Array.isArray(value);
        }

        function validateBackupString(value, label, maxLength, required) {
            if (value == null && !required) return '';
            if (typeof value !== 'string') throw new Error(label + '必须是文本');
            const clean = value.trim();
            if (required && !clean) throw new Error(label + '不能为空');
            if (clean.length > maxLength) throw new Error(label + '过长');
            return clean;
        }

        function validateBackupSong(song, playlistIndex, songIndex) {
            const prefix = '第 ' + (playlistIndex + 1) + ' 个歌单的第 ' + (songIndex + 1) + ' 首歌曲';
            if (!isPlainRecord(song)) throw new Error(prefix + '格式错误');
            const idIsNumber = typeof song.id === 'number' && Number.isFinite(song.id);
            const idIsString = typeof song.id === 'string' && !!song.id.trim() && song.id.trim().length <= 128;
            if (!idIsNumber && !idIsString) throw new Error(prefix + '缺少有效 id');
            return {
                id: idIsString ? song.id.trim() : song.id,
                name: validateBackupString(song.name, prefix + '名称', 300, true),
                artist: validateBackupString(song.artist, prefix + '歌手', 300, true),
                cover: validateBackupString(song.cover, prefix + '封面', 2048, false),
                album: validateBackupString(song.album, prefix + '专辑', 300, false),
                source: validateBackupString(song.source, prefix + '来源', 100, false) || 'Backup'
            };
        }

        function parsePlaylistBackup(text) {
            if (typeof text !== 'string' || !text.trim()) throw new Error('备份文件为空');
            if (new TextEncoder().encode(text).byteLength > PLAYLIST_BACKUP_MAX_BYTES) {
                throw new Error('备份文件超过 5 MB 限制');
            }
            let payload;
            try {
                payload = JSON.parse(text);
            } catch (error) {
                throw new Error('不是有效的 JSON 文件');
            }
            if (!isPlainRecord(payload)) throw new Error('备份根节点格式错误');
            if (payload.format !== PLAYLIST_BACKUP_FORMAT) throw new Error('不是 CPlayer 歌单备份');
            if (payload.version !== PLAYLIST_BACKUP_VERSION) throw new Error('不支持的备份版本');
            if (typeof payload.exportedAt !== 'string' || !Number.isFinite(Date.parse(payload.exportedAt))) {
                throw new Error('导出时间格式错误');
            }
            if (!Array.isArray(payload.playlists)) throw new Error('备份中缺少歌单列表');
            if (payload.playlists.length > PLAYLIST_BACKUP_MAX_PLAYLISTS) throw new Error('备份中的歌单数量过多');

            const playlists = payload.playlists.map(function (item, playlistIndex) {
                if (!isPlainRecord(item)) throw new Error('第 ' + (playlistIndex + 1) + ' 个歌单格式错误');
                const name = validateBackupString(item.name, '第 ' + (playlistIndex + 1) + ' 个歌单名称', 100, true);
                if (!Array.isArray(item.songs)) throw new Error('歌单「' + name + '」缺少歌曲列表');
                if (item.songs.length > PLAYLIST_BACKUP_MAX_SONGS) throw new Error('歌单「' + name + '」歌曲数量过多');
                return {
                    name: name,
                    songs: item.songs.map(function (song, songIndex) {
                        return validateBackupSong(song, playlistIndex, songIndex);
                    })
                };
            });
            return { format: PLAYLIST_BACKUP_FORMAT, version: PLAYLIST_BACKUP_VERSION, exportedAt: payload.exportedAt, playlists: playlists };
        }

        async function createPlaylistBackup() {
            const list = await listUserPlaylists();
            return {
                format: PLAYLIST_BACKUP_FORMAT,
                version: PLAYLIST_BACKUP_VERSION,
                exportedAt: new Date().toISOString(),
                playlists: list.map(function (item, playlistIndex) {
                    return {
                        name: validateBackupString(item.name, '第 ' + (playlistIndex + 1) + ' 个歌单名称', 100, true),
                        songs: item.songs.map(function (song, songIndex) {
                            return validateBackupSong(normalizeSongObject(song), playlistIndex, songIndex);
                        })
                    };
                })
            };
        }

        async function downloadPlaylistBackup() {
            const backup = await createPlaylistBackup();
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
            if (blob.size > PLAYLIST_BACKUP_MAX_BYTES) throw new Error('歌单数据超过 5 MB，无法生成可导入备份');
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const datePart = new Date().toISOString().slice(0, 10);
            link.href = url;
            link.download = 'cplayer-playlists-' + datePart + '.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            return backup.playlists.length;
        }

        function validateRecoveryPlaylistId(value, label) {
            const id = validateBackupString(value, label, 160, true);
            if (!id.startsWith(USER_PL_PREFIX)) throw new Error(label + ' id 鏃犳晥');
            return id;
        }

        function normalizeRecoveryTimestamp(value, label, allowZero) {
            const numberValue = Number(value);
            if (Number.isFinite(numberValue) && (allowZero ? numberValue >= 0 : numberValue > 0)) return numberValue;
            if (typeof value === 'string') {
                const parsed = Date.parse(value);
                if (Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0)) return parsed;
            }
            throw new Error(label + '鏃堕棿鏍煎紡閿欒');
        }

        function readRecoveryHistoryRecords(playlistIds) {
            if (!db || !hasPlaylistHistoryStore() || !playlistIds.size) return Promise.resolve([]);
            return new Promise(function (resolve, reject) {
                let tx;
                let requestError = null;
                let entries = [];
                try {
                    tx = db.transaction(PLAYLIST_HISTORY_STORE, 'readonly');
                    const request = tx.objectStore(PLAYLIST_HISTORY_STORE).getAll();
                    request.onsuccess = function () { entries = request.result || []; };
                    request.onerror = function () { requestError = request.error; };
                } catch (error) {
                    reject(error);
                    return;
                }
                transactionDone(tx).then(function () {
                    const normalized = [];
                    entries.forEach(function (entry) {
                        if (!entry || !playlistIds.has(String(entry.playlistId || ''))) return;
                        try {
                            const item = normalizePlaylistVersion(entry);
                            normalized.push({
                                sourcePlaylistId: item.playlistId,
                                name: item.name,
                                songs: item.songs.map(function (song) {
                                    return validateBackupSong(song, 0, 0);
                                }),
                                createdAt: item.createdAt,
                                reason: item.reason,
                                snapshotId: item.snapshotId
                            });
                        } catch (error) {
                            throw new Error('本地历史版本格式损坏，无法生成恢复包');
                        }
                    });
                    resolve(normalized);
                }, function (error) {
                    reject(requestError || error);
                });
            });
        }

        async function createRecoveryPackage() {
            const records = await readUserPlaylistRecords({
                includeForeign: true,
                includeTrash: true,
                includePurged: false
            });
            const playlists = records.map(function (item, playlistIndex) {
                const state = normalizeLocalPlaylistState(item);
                if (!Array.isArray(item.songs)) throw new Error('本地歌单歌曲数据损坏，无法生成恢复包');
                return {
                    sourceId: validateRecoveryPlaylistId(item.id, 'playlist #' + (playlistIndex + 1)),
                    name: validateBackupString(item.name, 'playlist #' + (playlistIndex + 1) + ' name', 100, true),
                    songs: item.songs.map(function (song, songIndex) {
                        return validateBackupSong(normalizeSongObject(song), playlistIndex, songIndex);
                    }),
                    deletedAt: state.deletedAt
                };
            });
            if (playlists.length > PLAYLIST_BACKUP_MAX_PLAYLISTS) {
                throw new Error('恢复包中的歌单数量过多');
            }
            const playlistIds = new Set(playlists.map(function (item) { return item.sourceId; }));
            const history = await readRecoveryHistoryRecords(playlistIds);
            if (history.length > RECOVERY_PACKAGE_MAX_HISTORY) {
                throw new Error('恢复包中的历史版本数量过多');
            }
            return {
                format: RECOVERY_PACKAGE_FORMAT,
                version: RECOVERY_PACKAGE_VERSION,
                exportedAt: new Date().toISOString(),
                playlists: playlists,
                history: history
            };
        }

        async function downloadRecoveryPackage() {
            const recovery = await createRecoveryPackage();
            const blob = new Blob([JSON.stringify(recovery, null, 2)], { type: 'application/json;charset=utf-8' });
            if (blob.size > PLAYLIST_BACKUP_MAX_BYTES) throw new Error('恢复包超过 5 MB，无法生成可导入文件');
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'cplayer-recovery-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            return { playlistCount: recovery.playlists.length, historyCount: recovery.history.length };
        }

        function parseRecoveryPackage(text) {
            if (typeof text !== 'string' || !text.trim()) throw new Error('恢复包文件为空');
            if (new TextEncoder().encode(text).byteLength > PLAYLIST_BACKUP_MAX_BYTES) {
                throw new Error('恢复包文件超过 5 MB 限制');
            }
            let payload;
            try {
                payload = JSON.parse(text);
            } catch (error) {
                throw new Error('不是有效的 JSON 文件');
            }
            if (!isPlainRecord(payload)) throw new Error('恢复包根节点格式错误');
            if (payload.format !== RECOVERY_PACKAGE_FORMAT) throw new Error('不是 CPlayer 恢复包');
            if (payload.version !== RECOVERY_PACKAGE_VERSION) throw new Error('不支持的恢复包版本');
            if (typeof payload.exportedAt !== 'string' || !Number.isFinite(Date.parse(payload.exportedAt))) {
                throw new Error('恢复包导出时间格式错误');
            }
            if (!Array.isArray(payload.playlists)) throw new Error('恢复包中缺少歌单列表');
            if (payload.playlists.length > PLAYLIST_BACKUP_MAX_PLAYLISTS) throw new Error('恢复包中的歌单数量过多');
            if (!Array.isArray(payload.history)) throw new Error('恢复包中缺少历史版本列表');
            if (payload.history.length > RECOVERY_PACKAGE_MAX_HISTORY) throw new Error('恢复包中的历史版本数量过多');

            const sourceIds = new Set();
            const playlists = payload.playlists.map(function (item, playlistIndex) {
                if (!isPlainRecord(item)) throw new Error('第' + (playlistIndex + 1) + ' 个恢复歌单格式错误');
                const sourceId = validateRecoveryPlaylistId(item.sourceId, '第' + (playlistIndex + 1) + ' 个恢复歌单');
                if (sourceIds.has(sourceId)) throw new Error('恢复包中存在重复歌单 id');
                sourceIds.add(sourceId);
                const name = validateBackupString(item.name, '第' + (playlistIndex + 1) + ' 个恢复歌单名称', 100, true);
                if (!Array.isArray(item.songs)) throw new Error('恢复歌单“' + name + '”缺少歌曲列表');
                if (item.songs.length > PLAYLIST_BACKUP_MAX_SONGS) throw new Error('恢复歌单“' + name + '”歌曲数量过多');
                const deletedAt = item.deletedAt == null ? 0 : normalizeRecoveryTimestamp(item.deletedAt, '恢复歌单删除时间', true);
                return {
                    sourceId: sourceId,
                    name: name,
                    songs: item.songs.map(function (song, songIndex) {
                        return validateBackupSong(song, playlistIndex, songIndex);
                    }),
                    deletedAt: deletedAt
                };
            });

            const history = payload.history.map(function (item, historyIndex) {
                if (!isPlainRecord(item)) throw new Error('第' + (historyIndex + 1) + ' 个历史版本格式错误');
                const sourcePlaylistId = validateRecoveryPlaylistId(item.sourcePlaylistId, '第' + (historyIndex + 1) + ' 个历史版本歌单');
                if (!sourceIds.has(sourcePlaylistId)) throw new Error('历史版本引用了不存在的歌单');
                const name = validateBackupString(item.name, '第' + (historyIndex + 1) + ' 个历史版本名称', 100, true);
                if (!Array.isArray(item.songs)) throw new Error('历史版本“' + name + '”缺少歌曲列表');
                if (item.songs.length > PLAYLIST_BACKUP_MAX_SONGS) throw new Error('历史版本“' + name + '”歌曲数量过多');
                const snapshotId = validateBackupString(item.snapshotId, '第' + (historyIndex + 1) + ' 个历史版本 snapshotId', 200, true);
                const createdAt = normalizeRecoveryTimestamp(item.createdAt, '历史版本创建时间', false);
                const reason = ['edit', 'delete', 'restore', 'remote'].includes(item.reason) ? item.reason : 'edit';
                return {
                    sourcePlaylistId: sourcePlaylistId,
                    name: name,
                    songs: item.songs.map(function (song, songIndex) {
                        return validateBackupSong(song, historyIndex, songIndex);
                    }),
                    createdAt: createdAt,
                    reason: reason,
                    snapshotId: snapshotId
                };
            });
            return {
                format: RECOVERY_PACKAGE_FORMAT,
                version: RECOVERY_PACKAGE_VERSION,
                exportedAt: payload.exportedAt,
                playlists: playlists,
                history: history
            };
        }

        function getUniqueRecoveredPlaylistName(name, usedNames) {
            const key = function (value) { return value.toLocaleLowerCase(); };
            const base = makeRecoveredPlaylistName(name);
            if (!usedNames.has(key(base))) {
                usedNames.add(key(base));
                return base;
            }
            let suffix = 2;
            let candidate = '';
            while (true) {
                const suffixText = '（恢复 ' + suffix + '）';
                candidate = String(name || '未命名歌单').slice(0, 100 - suffixText.length).trimEnd() + suffixText;
                if (!usedNames.has(key(candidate))) break;
                suffix += 1;
            }
            usedNames.add(key(candidate));
            return candidate;
        }

        async function readRecoveryPackageFile(file) {
            if (!file || typeof file.text !== 'function') throw new Error('请选择 JSON 恢复包文件');
            if (file.size > PLAYLIST_BACKUP_MAX_BYTES) throw new Error('恢复包文件超过 5 MB 限制');
            if (file.name && !/\.json$/i.test(file.name)) throw new Error('请选择 .json 恢复包文件');
            return parseRecoveryPackage(await file.text());
        }

        async function createRecoveryImportPlan(parsed) {
            if (!db && typeof initDatabase === 'function') await initDatabase();
            if (!db) throw new Error('数据库未就绪');

            const existing = await listUserPlaylists({ includeForeign: true, includeTrash: true, includePurged: true });
            const existingNames = new Set(existing.map(function (item) { return String(item.name || '').toLocaleLowerCase(); }));
            const usedNames = new Set(existingNames);
            const usedIds = new Set(existing.map(function (item) { return item.id; }));
            const sourceNames = new Set();
            let conflictCount = 0;
            const idMap = new Map();
            const now = Date.now();
            const records = parsed.playlists.map(function (item, index) {
                const sourceNameKey = String(item.name || '').toLocaleLowerCase();
                if (existingNames.has(sourceNameKey) || sourceNames.has(sourceNameKey)) conflictCount += 1;
                sourceNames.add(sourceNameKey);
                const id = createUserPlaylistId(usedIds);
                idMap.set(item.sourceId, id);
                return {
                    id: id,
                    name: getUniqueRecoveredPlaylistName(item.name, usedNames),
                    songs: item.songs,
                    timestamp: now - index,
                    deletedAt: item.deletedAt || 0,
                    purgedAt: 0,
                    cloudOwnerId: '',
                    cloudVersion: 0,
                    cloudDirty: false
                };
            });
            const history = parsed.history.map(function (item) {
                const playlistId = idMap.get(item.sourcePlaylistId);
                return {
                    id: makeCloudMutationId(),
                    playlistId: playlistId,
                    name: item.name,
                    songs: item.songs,
                    createdAt: item.createdAt,
                    reason: item.reason,
                    snapshotId: item.snapshotId,
                    cloudOwnerId: ''
                };
            });

            return {
                records: records,
                history: history,
                summary: {
                    activeCount: parsed.playlists.filter(function (item) { return !item.deletedAt; }).length,
                    trashCount: parsed.playlists.filter(function (item) { return !!item.deletedAt; }).length,
                    historyCount: history.length,
                    conflictCount: conflictCount
                }
            };
        }

        async function commitRecoveryImportPlan(plan) {
            if (!plan || !Array.isArray(plan.records) || !Array.isArray(plan.history)) {
                throw new Error('恢复包导入计划无效');
            }
            if (!db && typeof initDatabase === 'function') await initDatabase();
            if (!db) throw new Error('数据库未就绪');
            const records = plan.records;
            const history = plan.history;

            try {
                await runCriticalStorageWrite(async function () {
                    const stores = ['playlists'];
                    if (hasPlaylistHistoryStore()) stores.push(PLAYLIST_HISTORY_STORE);
                    const tx = db.transaction(stores, 'readwrite');
                    const playlistStore = tx.objectStore('playlists');
                    try {
                        records.forEach(function (record) { playlistStore.put(record); });
                        if (hasPlaylistHistoryStore()) {
                            const historyStore = tx.objectStore(PLAYLIST_HISTORY_STORE);
                            history.forEach(function (entry) { historyStore.put(entry); });
                        }
                    } catch (error) {
                        try { tx.abort(); } catch (abortError) {}
                        throw error;
                    }
                    await transactionDone(tx);
                });
            } catch (error) {
                setStorageState('degraded', isQuotaExceededError(error)
                    ? '恢复包导入失败，浏览器存储空间不足'
                    : STORAGE_WARNING, error);
                throw error;
            }
            return { records: records, historyCount: history.length };
        }

        async function importRecoveryPackageFile(file) {
            const parsed = await readRecoveryPackageFile(file);
            const plan = await createRecoveryImportPlan(parsed);
            return commitRecoveryImportPlan(plan);
        }

        function getUniqueImportedPlaylistName(name, usedNames) {
            const key = function (value) { return value.toLocaleLowerCase(); };
            if (!usedNames.has(key(name))) {
                usedNames.add(key(name));
                return name;
            }
            let suffix = 1;
            let suffixText = ' (导入)';
            let candidate = name.slice(0, 100 - suffixText.length) + suffixText;
            while (usedNames.has(key(candidate))) {
                suffix += 1;
                suffixText = ' (导入 ' + suffix + ')';
                candidate = name.slice(0, 100 - suffixText.length) + suffixText;
            }
            usedNames.add(key(candidate));
            return candidate;
        }

        async function importPlaylistBackupFile(file) {
            if (!file || typeof file.text !== 'function') throw new Error('请选择 JSON 备份文件');
            if (file.size > PLAYLIST_BACKUP_MAX_BYTES) throw new Error('备份文件超过 5 MB 限制');
            if (file.name && !/\.json$/i.test(file.name)) throw new Error('请选择 .json 备份文件');
            const parsed = parsePlaylistBackup(await file.text());
            if (!db && typeof initDatabase === 'function') await initDatabase();
            if (!db) throw new Error('数据库未就绪');

            const existing = await listUserPlaylists({ includeTrash: true });
            if (cloudUserId && existing.length + parsed.playlists.length > CLOUD_MAX_PLAYLISTS) {
                throw new Error('云端歌单数量达到上限');
            }
            const usedNames = new Set(existing.map(function (item) { return item.name.toLocaleLowerCase(); }));
            const usedIds = new Set(existing.map(function (item) { return item.id; }));
            const now = Date.now();
            const records = parsed.playlists.map(function (item, index) {
                return {
                    id: createUserPlaylistId(usedIds),
                    name: getUniqueImportedPlaylistName(item.name, usedNames),
                    songs: item.songs,
                    timestamp: now - index,
                    cloudOwnerId: cloudUserId || '',
                    cloudVersion: 0,
                    cloudDirty: !!cloudUserId
                };
            });
            const outboxRecords = cloudUserId
                ? records.map(function (record) {
                    return makeCloudOutboxRecord(cloudUserId, record, 'upsert', 0);
                })
                : [];

            try {
                await runCriticalStorageWrite(async function () {
                    const stores = outboxRecords.length
                        ? ['playlists', CLOUD_OUTBOX_STORE]
                        : ['playlists'];
                    const tx = db.transaction(stores, 'readwrite');
                    const store = tx.objectStore('playlists');
                    try {
                        records.forEach(function (record) { store.put(record); });
                        outboxRecords.forEach(function (record) {
                            tx.objectStore(CLOUD_OUTBOX_STORE).put(record);
                        });
                    } catch (error) {
                        try { tx.abort(); } catch (abortError) {}
                        throw error;
                    }
                    await transactionDone(tx);
                });
            } catch (error) {
                setStorageState('degraded', isQuotaExceededError(error)
                    ? '歌单导入失败，浏览器存储空间不足'
                    : STORAGE_WARNING, error);
                throw error;
            }
            if (outboxRecords.length) {
                setCloudState('pending', '导入的歌单已保存在本机，等待同步');
                scheduleCloudSync('playlist_import');
            }
            return records;
        }

        async function createUserPlaylist(name) {
            if (!db && typeof initDatabase === 'function') {
                try { await initDatabase(); } catch (e) {}
            }
            if (!db) throw new Error('数据库未就绪');
            if (cloudUserId && (await listUserPlaylists({ includeTrash: true })).length >= CLOUD_MAX_PLAYLISTS) {
                throw new Error('云端歌单数量达到上限');
            }
            const clean = String(name || '').trim() || ('我的歌单 ' + new Date().toLocaleDateString());
            if (clean.length > 100) throw new Error('歌单名称不能超过 100 个字符');
            const id = createUserPlaylistId();
            return await saveUserPlaylistRecord({ id: id, name: clean, songs: [] });
        }

        async function addSongToUserPlaylist(playlistId, song) {
            const list = await listUserPlaylists();
            const target = list.find(function (p) { return p.id === playlistId; });
            if (!target) throw new Error('歌单不存在');
            const newSong = normalizeSongObject(song);
            if (!target.songs.some(function (s) { return String(s.id) === String(newSong.id); })) {
                target.songs.push(newSong);
            }
            await saveUserPlaylistRecord(target);
            return target;
        }

        async function deleteUserPlaylist(playlistId) {
            if (!db) {
                const error = new Error('浏览器存储不可用，无法删除歌单');
                error.name = 'StorageUnavailableError';
                setStorageState(storageState === 'stale' ? 'stale' : 'degraded',
                    storageState === 'stale' ? '播放器数据已在其他页面升级，请刷新当前页面' : STORAGE_WARNING, error);
                throw error;
            }
            try {
                const records = await readUserPlaylistRecords({
                    includeForeign: true,
                    includeTrash: true,
                    includePurged: true
                });
                const existing = records.find(function (record) { return record.id === playlistId; });
                if (!existing || existing.deletedAt || existing.purgedAt) throw new Error('歌单不存在');
                await saveUserPlaylistRecord(Object.assign({}, existing, {
                    deletedAt: Date.now(),
                    purgedAt: 0
                }), {
                    operation: 'delete',
                    skipHistory: true
                });
            } catch (error) {
                setStorageState('degraded', STORAGE_WARNING, error);
                throw error;
            }
        }

        async function restoreUserPlaylist(playlistId) {
            const records = await readUserPlaylistRecords({
                includeForeign: true,
                onlyTrash: true
            });
            const existing = records.find(function (record) { return record.id === playlistId; });
            if (!existing) throw new Error('回收站中没有这个歌单');
            return saveUserPlaylistRecord(Object.assign({}, existing, {
                deletedAt: 0,
                purgedAt: 0
            }), {
                operation: 'restore',
                historyReason: 'restore'
            });
        }

        async function restorePlaylistVersion(playlistId, version) {
            const normalized = normalizePlaylistVersion(version);
            if (normalized.playlistId !== playlistId) throw new Error('历史版本不属于这个歌单');
            const records = await readUserPlaylistRecords({
                includeForeign: true,
                includeTrash: true
            });
            const existing = records.find(function (record) { return record.id === playlistId; });
            if (!existing || existing.purgedAt) throw new Error('歌单已不存在');
            return saveUserPlaylistRecord(Object.assign({}, existing, {
                name: normalized.name,
                songs: normalized.songs,
                deletedAt: 0,
                purgedAt: 0
            }), {
                operation: 'restore',
                historyReason: 'restore'
            });
        }

        async function purgeUserPlaylist(playlistId) {
            if (!db || !hasPlaylistHistoryStore()) throw new Error('数据库未就绪');
            const records = await readUserPlaylistRecords({
                includeForeign: true,
                includeTrash: true,
                includePurged: true
            });
            const existing = records.find(function (record) { return record.id === playlistId; });
            if (!existing || existing.purgedAt) return false;
            const fields = normalizeLocalCloudFields(existing);
            const now = Date.now();
            await runCriticalStorageWrite(async function () {
                const stores = ['playlists', PLAYLIST_HISTORY_STORE];
                if (fields.cloudOwnerId) {
                    if (!hasCloudOutboxStore()) throw new Error('云同步存储未就绪');
                    stores.push(CLOUD_OUTBOX_STORE);
                }
                const tx = db.transaction(stores, 'readwrite');
                const playlistStore = tx.objectStore('playlists');
                const historyStore = tx.objectStore(PLAYLIST_HISTORY_STORE);
                const historyRequest = historyStore.index('playlistId').getAll(IDBKeyRange.only(playlistId));
                historyRequest.onsuccess = function () {
                    (historyRequest.result || []).forEach(function (entry) {
                        if (isPlaylistVersionInOwnerScope(entry, fields.cloudOwnerId)) {
                            historyStore.delete(entry.id);
                        }
                    });
                };
                if (fields.cloudOwnerId) {
                    playlistStore.put({
                        id: playlistId,
                        name: '已永久删除',
                        songs: [],
                        timestamp: now,
                        deletedAt: existing.deletedAt || now,
                        purgedAt: now,
                        cloudOwnerId: fields.cloudOwnerId,
                        cloudVersion: fields.cloudVersion,
                        cloudDirty: true
                    });
                    tx.objectStore(CLOUD_OUTBOX_STORE).put(makeCloudOutboxRecord(
                        fields.cloudOwnerId,
                        { id: playlistId },
                        'purge',
                        fields.cloudVersion
                    ));
                } else {
                    playlistStore.delete(playlistId);
                }
                await transactionDone(tx);
            });
            if (fields.cloudOwnerId) {
                setCloudState('pending', navigator.onLine === false
                    ? '永久删除已保存在本机，联网后同步'
                    : '永久删除等待同步');
                scheduleCloudSync('playlist_purge');
            }
            return true;
        }

        async function cleanupExpiredLocalTrash() {
            const trash = await readUserPlaylistRecords({ includeForeign: true, onlyTrash: true });
            const expired = trash.filter(function (record) {
                return isPlaylistTrashExpired(record.deletedAt, Date.now());
            });
            for (const record of expired) await purgeUserPlaylist(record.id);
            return expired.length;
        }

        async function adoptLocalPlaylistsForCloud(ownerId) {
            if (!db || !ownerId || !hasCloudOutboxStore() || !hasPlaylistHistoryStore()) return 0;
            let adopted = 0;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE, PLAYLIST_HISTORY_STORE], 'readwrite');
            const store = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const historyStore = tx.objectStore(PLAYLIST_HISTORY_STORE);
            const playlistRequest = store.getAll();
            const historyRequest = historyStore.getAll();
            let playlistsReady = false;
            let historyReady = false;
            let playlists = [];
            let histories = [];
            let wrote = false;
            const adopt = function () {
                if (wrote || !playlistsReady || !historyReady) return;
                wrote = true;
                const byPlaylist = new Map();
                histories.forEach(function (entry) {
                    if (!entry || !entry.playlistId) return;
                    if (!byPlaylist.has(entry.playlistId)) byPlaylist.set(entry.playlistId, []);
                    byPlaylist.get(entry.playlistId).push(entry);
                });
                playlists.forEach(function (record) {
                    if (!record || typeof record.id !== 'string' ||
                        record.id.indexOf(USER_PL_PREFIX) !== 0) return;
                    const fields = normalizeLocalCloudFields(record);
                    const state = normalizeLocalPlaylistState(record);
                    if (fields.cloudOwnerId || state.purgedAt) return;
                    const next = Object.assign({}, record, {
                        cloudOwnerId: ownerId,
                        cloudVersion: 0,
                        cloudDirty: true
                    });
                    store.put(next);
                    const retained = retainValidPlaylistVersions((byPlaylist.get(record.id) || []).filter(function (entry) {
                        return isPlaylistVersionInOwnerScope(entry, '');
                    }), Date.now()).map(function (entry) {
                        const owned = Object.assign({}, entry, { cloudOwnerId: ownerId });
                        historyStore.put(owned);
                        return owned;
                    });
                    outboxStore.put(makeCloudOutboxRecord(
                        ownerId,
                        next,
                        state.deletedAt ? 'delete' : 'upsert',
                        0,
                        retained
                    ));
                    adopted += 1;
                });
            };
            playlistRequest.onsuccess = function () {
                playlists = playlistRequest.result || [];
                playlistsReady = true;
                adopt();
            };
            historyRequest.onsuccess = function () {
                histories = historyRequest.result || [];
                historyReady = true;
                adopt();
            };
            playlistRequest.onerror = historyRequest.onerror = function () {
                try { tx.abort(); } catch (abortError) {}
            };
            await transactionDone(tx);
            return adopted;
        }

        async function acknowledgeCloudUpsert(ownerId, sentOutbox, remote) {
            if (!db || !hasCloudOutboxStore() || !sentOutbox || !remote || cloudUserId !== ownerId) return;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const playlistRequest = playlistStore.get(sentOutbox.playlistId);
            const outboxRequest = outboxStore.get(sentOutbox.id);
            let local = null;
            let currentOutbox = null;
            playlistRequest.onsuccess = function () { local = playlistRequest.result || null; };
            outboxRequest.onsuccess = function () { currentOutbox = outboxRequest.result || null; };
            await transactionDone(tx);
            if (!local || normalizeLocalCloudFields(local).cloudOwnerId !== ownerId) return;

            const nextTx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            const nextPlaylistStore = nextTx.objectStore('playlists');
            const nextOutboxStore = nextTx.objectStore(CLOUD_OUTBOX_STORE);
            const currentRequest = nextOutboxStore.get(sentOutbox.id);
            currentRequest.onsuccess = function () {
                if (cloudUserId !== ownerId) return;
                const latestOutbox = currentRequest.result || null;
                const latestLocalRequest = nextPlaylistStore.get(sentOutbox.playlistId);
                latestLocalRequest.onsuccess = function () {
                    if (cloudUserId !== ownerId) return;
                    const latestLocal = latestLocalRequest.result || null;
                    if (!latestLocal || normalizeLocalCloudFields(latestLocal).cloudOwnerId !== ownerId) return;
                    const sameMutation = isSameCloudMutation(latestOutbox, sentOutbox);
                    const updated = Object.assign({}, latestLocal, {
                        cloudOwnerId: ownerId,
                        cloudVersion: remote.version,
                        cloudDirty: !sameMutation
                    });
                    nextPlaylistStore.put(updated);
                    if (sameMutation) {
                        nextOutboxStore.delete(sentOutbox.id);
                    } else if (latestOutbox) {
                        nextOutboxStore.put(Object.assign({}, latestOutbox, {
                            expectedVersion: remote.version
                        }));
                    }
                };
            };
            await transactionDone(nextTx);
        }

        async function applyRemotePlaylistToLocal(ownerId, remote) {
            if (!db || !hasCloudOutboxStore() || !hasPlaylistHistoryStore() || !remote) return;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE, PLAYLIST_HISTORY_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const historyStore = tx.objectStore(PLAYLIST_HISTORY_STORE);
            const localRequest = playlistStore.get(remote.id);
            let collisionError = null;
            localRequest.onsuccess = function () {
                const local = localRequest.result || null;
                const localOwner = normalizeLocalCloudFields(local).cloudOwnerId;
                if (local && localOwner && localOwner !== ownerId) {
                    collisionError = makeCloudOwnerCollisionError();
                    return;
                }
                playlistStore.put({
                    id: remote.id,
                    name: remote.name,
                    songs: remote.songs,
                    timestamp: remote.updatedAt,
                    cloudOwnerId: ownerId,
                    cloudVersion: remote.version,
                    cloudDirty: false,
                    deletedAt: remote.deletedAt || 0,
                    purgedAt: remote.purgedAt || 0
                });
                if (remote.purgedAt) {
                    const historyRequest = historyStore.index('playlistId').getAll(IDBKeyRange.only(remote.id));
                    historyRequest.onsuccess = function () {
                        (historyRequest.result || []).forEach(function (entry) {
                            if (isPlaylistVersionInOwnerScope(entry, ownerId)) historyStore.delete(entry.id);
                        });
                    };
                }
                outboxStore.delete(makeCloudOutboxId(ownerId, remote.id));
                if (local && typeof refreshMyPlaylists === 'function') {
                    setTimeout(function () { refreshMyPlaylists(); }, 0);
                }
            };
            await transactionDone(tx);
            if (collisionError) throw collisionError;
        }

        async function removeLocalCloudPlaylist(ownerId, playlistId) {
            if (!db || !hasCloudOutboxStore() || !hasPlaylistHistoryStore()) return;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE, PLAYLIST_HISTORY_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const historyStore = tx.objectStore(PLAYLIST_HISTORY_STORE);
            const localRequest = playlistStore.get(playlistId);
            localRequest.onsuccess = function () {
                const local = localRequest.result || null;
                const localOwner = normalizeLocalCloudFields(local).cloudOwnerId;
                if (!local || localOwner === ownerId) {
                    playlistStore.delete(playlistId);
                    const historyRequest = historyStore.index('playlistId').getAll(IDBKeyRange.only(playlistId));
                    historyRequest.onsuccess = function () {
                        (historyRequest.result || []).forEach(function (entry) {
                            if (isPlaylistVersionInOwnerScope(entry, ownerId)) historyStore.delete(entry.id);
                        });
                    };
                }
                outboxStore.delete(makeCloudOutboxId(ownerId, playlistId));
            };
            await transactionDone(tx);
        }

        async function acknowledgeCloudDelete(ownerId, sentOutbox, remote) {
            if (!sentOutbox) return;
            await acknowledgeCloudUpsert(ownerId, sentOutbox, remote || { version: 0 });
        }

        async function acknowledgeCloudPurge(ownerId, sentOutbox, remote) {
            if (!sentOutbox) return;
            await acknowledgeCloudUpsert(ownerId, sentOutbox, remote || { version: 0 });
            if (!db || !hasPlaylistHistoryStore()) return;
            const tx = db.transaction(PLAYLIST_HISTORY_STORE, 'readwrite');
            const store = tx.objectStore(PLAYLIST_HISTORY_STORE);
            const request = store.index('playlistId').getAll(IDBKeyRange.only(sentOutbox.playlistId));
            request.onsuccess = function () {
                (request.result || []).forEach(function (entry) {
                    if (isPlaylistVersionInOwnerScope(entry, ownerId)) store.delete(entry.id);
                });
            };
            await transactionDone(tx);
        }

        async function detachCloudOwner(ownerId) {
            if (!ownerId) throw new Error('缺少待清理的云账号');
            if (!db || !hasCloudOutboxStore() || !hasPlaylistHistoryStore()) throw new Error('本机数据库未就绪，无法清理云账号标记');
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE, PLAYLIST_HISTORY_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const historyStore = tx.objectStore(PLAYLIST_HISTORY_STORE);
            const playlistRequest = playlistStore.getAll();
            const outboxRequest = outboxStore.indexNames.contains('ownerId')
                ? outboxStore.index('ownerId').getAll(IDBKeyRange.only(ownerId))
                : outboxStore.getAll();
            playlistRequest.onsuccess = function () {
                (playlistRequest.result || []).forEach(function (record) {
                    if (normalizeLocalCloudFields(record).cloudOwnerId !== ownerId) return;
                    if (normalizeLocalPlaylistState(record).purgedAt) {
                        playlistStore.delete(record.id);
                        const purgedHistoryRequest = historyStore.index('playlistId')
                            .getAll(IDBKeyRange.only(record.id));
                        purgedHistoryRequest.onsuccess = function () {
                            (purgedHistoryRequest.result || []).forEach(function (entry) {
                                if (isPlaylistVersionInOwnerScope(entry, ownerId)) {
                                    historyStore.delete(entry.id);
                                }
                            });
                        };
                        return;
                    }
                    const next = Object.assign({}, record);
                    delete next.cloudOwnerId;
                    delete next.cloudVersion;
                    delete next.cloudDirty;
                    playlistStore.put(next);
                });
            };
            outboxRequest.onsuccess = function () {
                (outboxRequest.result || []).forEach(function (record) {
                    if (!record || record.ownerId === ownerId) outboxStore.delete(record.id);
                });
            };
            const historyRequest = historyStore.indexNames.contains('cloudOwnerId')
                ? historyStore.index('cloudOwnerId').getAll(IDBKeyRange.only(ownerId))
                : historyStore.getAll();
            historyRequest.onsuccess = function () {
                (historyRequest.result || []).forEach(function (entry) {
                    if (!entry || entry.cloudOwnerId !== ownerId) return;
                    historyStore.put(Object.assign({}, entry, { cloudOwnerId: '' }));
                });
            };
            await transactionDone(tx);
        }

        async function repairPendingCloudDetach() {
            const raw = readLocalStorage(CLOUD_DETACH_PENDING_KEY, '');
            if (!raw) return false;
            let ownerId = '';
            try {
                const parsed = JSON.parse(raw);
                ownerId = parsed && parsed.confirmed === true && typeof parsed.ownerId === 'string'
                    ? parsed.ownerId.trim()
                    : '';
            } catch (error) {}
            if (!ownerId) {
                removeLocalStorage(CLOUD_DETACH_PENDING_KEY);
                return false;
            }
            await detachCloudOwner(ownerId);
            forgetCloudSyncSuccess(ownerId);
            forgetCloudSyncError(ownerId);
            removeLocalStorage(CLOUD_DETACH_PENDING_KEY);
            return true;
        }

        async function loadUserPlaylistIntoQueue(playlistId, autoPlay) {
            const list = await listUserPlaylists();
            const target = list.find(function (p) { return p.id === playlistId; });
            if (!target || !target.songs.length) {
                if (typeof showToast === 'function') showToast('歌单为空', true);
                return;
            }
            suppressQueueAutosave = true;
            playlist = target.songs.map(normalizeSongObject);
            window.playlist = playlist;
            currentIndex = -1;
            playlistTotalCount = playlist.length;
            allSongsLoaded = true;
            playlistSource = 'user_playlist';
            playlistSourceName = target.name;
            if (playMode === 'shuffle' && typeof shufflePlaylist === 'function') shufflePlaylist();
            if (typeof initPlaylistView === 'function') initPlaylistView();
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
            suppressQueueAutosave = false;
            scheduleSaveCurrentQueue('load_user_playlist');
            if (typeof showToast === 'function') showToast('已加载歌单: ' + target.name);
            if (autoPlay && playlist.length && typeof window.playSongAtIndex === 'function') window.playSongAtIndex(0);
        }

        const accessibleOverlayStack = [];
        let accessibleOverlayBackgroundState = null;
        let accessibleOverlayManagerBound = false;

        function getFocusableElements(root) {
            if (!root) return [];
            const selector = [
                'a[href]', 'button:not([disabled])', 'input:not([disabled])',
                'select:not([disabled])', 'textarea:not([disabled])', 'summary',
                '[tabindex]:not([tabindex="-1"])'
            ].join(',');
            return Array.from(root.querySelectorAll(selector)).filter(function (element) {
                if (element.inert || element.closest('[inert]')) return false;
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
            });
        }

        function getTopAccessibleOverlay() {
            return accessibleOverlayStack[accessibleOverlayStack.length - 1] || null;
        }

        function syncAccessibleOverlayBackground() {
            const top = getTopAccessibleOverlay();
            if (!top) {
                if (accessibleOverlayBackgroundState) {
                    accessibleOverlayBackgroundState.forEach(function (wasInert, element) {
                        if (element.isConnected) element.inert = wasInert;
                    });
                }
                accessibleOverlayBackgroundState = null;
                return;
            }

            if (!accessibleOverlayBackgroundState) {
                accessibleOverlayBackgroundState = new Map();
                Array.from(document.body.children).forEach(function (element) {
                    accessibleOverlayBackgroundState.set(element, Boolean(element.inert));
                });
            }

            Array.from(document.body.children).forEach(function (element) {
                const original = accessibleOverlayBackgroundState.get(element) || false;
                const ownsTopOverlay = element === top.modal || element.contains(top.modal);
                element.inert = original || !ownsTopOverlay;
            });
            top.modal.inert = false;
        }

        function focusAccessibleOverlay(entry) {
            if (!entry || !entry.modal.isConnected) return;
            let target = null;
            if (typeof entry.initialFocus === 'function') target = entry.initialFocus();
            else if (typeof entry.initialFocus === 'string') target = entry.modal.querySelector(entry.initialFocus);
            else target = entry.initialFocus;
            if (!target) target = getFocusableElements(entry.modal)[0] || entry.modal;
            if (target === entry.modal && !entry.modal.hasAttribute('tabindex')) entry.modal.setAttribute('tabindex', '-1');
            requestAnimationFrame(function () {
                if (getTopAccessibleOverlay() === entry && target && target.isConnected) target.focus();
            });
        }

        function openAccessibleOverlay(modal, options) {
            if (!modal) return;
            const existing = accessibleOverlayStack.find(function (entry) { return entry.modal === modal; });
            if (existing) {
                focusAccessibleOverlay(existing);
                return;
            }
            const config = options || {};
            const active = document.activeElement;
            const entry = {
                modal: modal,
                close: typeof config.close === 'function' ? config.close : null,
                closeOnEscape: config.closeOnEscape !== false,
                initialFocus: config.initialFocus || null,
                returnFocus: active instanceof HTMLElement ? active : null
            };
            modal.inert = false;
            modal.setAttribute('aria-hidden', 'false');
            accessibleOverlayStack.push(entry);
            syncAccessibleOverlayBackground();
            focusAccessibleOverlay(entry);
        }

        function closeAccessibleOverlay(modal) {
            const index = accessibleOverlayStack.findIndex(function (entry) { return entry.modal === modal; });
            if (index < 0) return;
            const entry = accessibleOverlayStack[index];
            const wasTop = index === accessibleOverlayStack.length - 1;
            accessibleOverlayStack.splice(index, 1);
            modal.setAttribute('aria-hidden', 'true');
            modal.inert = true;
            syncAccessibleOverlayBackground();
            if (!wasTop) return;
            const target = entry.returnFocus;
            requestAnimationFrame(function () {
                const currentTop = getTopAccessibleOverlay();
                if (target && target.isConnected && !target.closest('[inert]')) target.focus();
                else if (currentTop) focusAccessibleOverlay(currentTop);
            });
        }

        function initAccessibleOverlayManager() {
            if (accessibleOverlayManagerBound) return;
            accessibleOverlayManagerBound = true;
            document.addEventListener('keydown', function (event) {
                const top = getTopAccessibleOverlay();
                if (top) {
                    if (event.key === 'Escape' && top.closeOnEscape && top.close) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        top.close();
                        return;
                    }
                    if (event.key !== 'Tab') return;
                    const focusable = getFocusableElements(top.modal);
                    if (!focusable.length) {
                        event.preventDefault();
                        top.modal.focus();
                        return;
                    }
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    const active = document.activeElement;
                    if (event.shiftKey && (active === first || !top.modal.contains(active))) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && (active === last || !top.modal.contains(active))) {
                        event.preventDefault();
                        first.focus();
                    }
                    return;
                }

                if (event.key !== 'Escape') return;
                const volumePopover = document.getElementById('volumePopover');
                const volumeButton = document.getElementById('volumeBtn');
                if (volumePopover && volumePopover.classList.contains('show')) {
                    event.preventDefault();
                    volumePopover.classList.remove('show');
                    volumePopover.setAttribute('aria-hidden', 'true');
                    volumePopover.inert = true;
                    if (volumeButton) {
                        volumeButton.setAttribute('aria-expanded', 'false');
                        volumeButton.focus();
                    }
                    return;
                }
                const sheet = document.getElementById('mobilePlaylistSheet');
                if (sheet && !sheet.inert && window.mobileUI) {
                    event.preventDefault();
                    window.mobileUI.closeSheet(true);
                    return;
                }
                const panel = document.getElementById('floatingPlaylistPanel');
                if (panel && !panel.inert) {
                    event.preventDefault();
                    togglePlaylistPanel(false, true);
                }
            }, true);
        }

        function setAccessibleTabState(tab, panel, isActive) {
            if (tab) {
                tab.setAttribute('aria-selected', String(isActive));
                tab.tabIndex = isActive ? 0 : -1;
            }
            if (panel) {
                panel.setAttribute('aria-hidden', String(!isActive));
                panel.inert = !isActive;
            }
        }

        function bindArrowTabNavigation(tabList, tabs, activate) {
            if (!tabList || tabList.dataset.keyboardBound === '1') return;
            const items = tabs.filter(Boolean);
            if (!items.length) return;
            tabList.dataset.keyboardBound = '1';
            tabList.addEventListener('keydown', function (event) {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const current = Math.max(0, items.indexOf(document.activeElement));
                let next = current;
                if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = items.length - 1;
                else if (event.key === 'ArrowRight') next = (current + 1) % items.length;
                else next = (current - 1 + items.length) % items.length;
                activate(items[next]);
                items[next].focus();
            });
        }

        function openAddToPlaylistModal(song) {
            try {
                pendingSongForPlaylist = normalizeSongObject(song);
                const modal = document.getElementById('userPlaylistModal');
                if (!modal) {
                    alert('歌单弹窗缺失，请强刷');
                    return;
                }
                modal.classList.remove('hidden');
                modal.setAttribute('aria-hidden', 'false');
                modal.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
                refreshUserPlaylistModalList();
                openAccessibleOverlay(modal, {
                    close: closeAddToPlaylistModal,
                    initialFocus: '#modalNewPlaylistName'
                });
            } catch (e) {
                console.error(e);
                alert('打开歌单失败');
            }
        }
        window.openAddToPlaylistModal = openAddToPlaylistModal;

        function closeAddToPlaylistModal() {
            const modal = document.getElementById('userPlaylistModal');
            if (!modal) return;
            modal.style.display = 'none';
            modal.classList.add('hidden');
            pendingSongForPlaylist = null;
            closeAccessibleOverlay(modal);
        }
        window.closeAddToPlaylistModal = closeAddToPlaylistModal;





        function escapeHtml(str) {
            return String(str == null ? '' : str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        async function refreshUserPlaylistModalList(statusText) {
            const box = document.getElementById('userPlaylistList');
            if (!box) return;
            if (statusText) {
                const tip = document.createElement('div');
                tip.className = 'p-2 mb-2 text-xs rounded-lg bg-white/10 text-white/80';
                tip.textContent = statusText;
                const existing = box.querySelector('[data-tip="1"]');
                if (existing) existing.remove();
                tip.dataset.tip = '1';
                box.prepend(tip);
            }
            try {
                const list = await listUserPlaylists();
                const rows = list.map(function (pl) {
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'w-full text-left p-3 rounded-xl bg-white/5 mb-2 flex items-center justify-between gap-3';
                    row.innerHTML = '<div class="min-w-0"><div class="font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-xs opacity-50">' + pl.songs.length + ' 首</div></div><span class="text-xs opacity-70">加入</span>';
                    row.onclick = async function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        try {
                            if (!pendingSongForPlaylist) return;
                            const name = pendingSongForPlaylist.name || '歌曲';
                            await addSongToUserPlaylist(pl.id, pendingSongForPlaylist);
                            if (typeof showToast === 'function') showToast('已加入: ' + pl.name + '（' + name + '）');
                            closeAddToPlaylistModal();
                            await refreshMyPlaylists();
                        } catch (e) {
                            console.error(e);
                            if (typeof showToast === 'function') showToast('加入失败', true);
                        }
                    };
                    return row;
                });
                // keep status tip on top
                const tip = box.querySelector('[data-tip="1"]');
                box.innerHTML = '';
                if (tip) box.appendChild(tip);
                if (!list.length) {
                    const empty = document.createElement('div');
                    empty.className = 'p-3 text-sm opacity-50 text-center';
                    empty.textContent = '还没有歌单，先新建一个吧';
                    box.appendChild(empty);
                } else {
                    rows.forEach(function (r) { box.appendChild(r); });
                }
            } catch (e) {
                console.error(e);
                box.innerHTML = '<div class="p-3 text-sm text-red-400">加载失败</div>';
            }
        }

async function refreshUserPlaylistLibrary() {
            const box = document.getElementById('userPlaylistLibrary');
            if (!box) return;
            try {
                const list = await listUserPlaylists();
                if (!list.length) {
                    box.innerHTML = '<div class="text-xs opacity-50 py-2">暂无自建歌单</div>';
                    return;
                }
                box.innerHTML = '';
                list.forEach(function (pl) {
                    const row = document.createElement('div');
                    row.className = 'flex items-center gap-2 p-2 rounded-xl bg-white/5 mb-2';
                    row.innerHTML = '<div class="flex-1 min-w-0"><div class="text-sm font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-[11px] opacity-50">' + pl.songs.length + ' 首</div></div><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="detail">管理</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="load">播放</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="del">删除</button>';
                    row.querySelector('[data-act="detail"]').onclick = function () { openPlaylistDetail(pl.id); };
                    row.querySelector('[data-act="load"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id, true); };
                    row.querySelector('[data-act="del"]').onclick = async function () {
                        if (!confirm('删除歌单「' + pl.name + '」？')) return;
                        try {
                            await deleteUserPlaylist(pl.id);
                            refreshUserPlaylistLibrary();
                            refreshPlaylistTrash();
                            if (typeof showToast === 'function') showToast('已移至回收站，可在 30 天内恢复');
                        } catch (error) {
                            console.error(error);
                            if (typeof showToast === 'function') showToast('删除失败：浏览器存储不可用', true);
                        }
                    };
                    box.appendChild(row);
                });
            } catch (e) { console.error(e); }
        }


        let activeLibraryTab = 'playlists';

        function makeLibraryActionButton(label, icon, className, visibleText) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = className || 'music-library-icon-button';
            button.title = label;
            button.setAttribute('aria-label', label);
            const iconElement = document.createElement('i');
            iconElement.className = 'fas ' + icon;
            iconElement.setAttribute('aria-hidden', 'true');
            button.appendChild(iconElement);
            if (visibleText) {
                const textElement = document.createElement('span');
                textElement.textContent = visibleText;
                button.appendChild(textElement);
            }
            return button;
        }

        function isOverlayInteractionTarget(target) {
            return !!(target && target.closest && target.closest(
                '#userPlaylistModal, #myPlaylistsModal, #playlistDetailModal, #playlistHistoryModal, #recoveryImportPreviewModal, #settingsModal, #welcomeModal'
            ));
        }

        async function refreshMyPlaylists() {
            const box = document.getElementById('myPlaylistsList');
            if (!box) return;
            try {
                const list = await listUserPlaylists();
                const count = document.getElementById('libraryPlaylistCount');
                if (count) count.textContent = String(list.length);
                box.innerHTML = '';
                if (!list.length) {
                    box.innerHTML = '<div class="h-full min-h-40 flex items-center justify-center text-center opacity-50 text-sm">还没有自建歌单</div>';
                    return;
                }
                list.forEach(function (pl) {
                    const row = document.createElement('div');
                    row.className = 'music-library-row';

                    const cover = document.createElement('div');
                    cover.className = 'music-library-cover';
                    cover.innerHTML = '<i class="fas fa-list-music fa-music opacity-40" aria-hidden="true"></i>';

                    const info = document.createElement('div');
                    info.className = 'min-w-0';
                    const name = document.createElement('div');
                    name.className = 'font-medium truncate';
                    name.textContent = pl.name;
                    const detail = document.createElement('div');
                    detail.className = 'text-xs opacity-50 mt-1';
                    detail.textContent = pl.songs.length + ' 首';
                    info.appendChild(name);
                    info.appendChild(detail);

                    const actions = document.createElement('div');
                    actions.className = 'music-library-row-actions flex items-center gap-2';
                    const playButton = makeLibraryActionButton('播放歌单「' + pl.name + '」', 'fa-play', 'music-library-action-button', '播放');
                    playButton.onclick = async function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        await loadUserPlaylistIntoQueue(pl.id, true);
                        closeMyPlaylists();
                    };
                    const manageButton = makeLibraryActionButton('管理歌单「' + pl.name + '」', 'fa-sliders-h', 'music-library-action-button', '管理');
                    manageButton.onclick = function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        Promise.resolve(openPlaylistDetail(pl.id)).catch(function (error) {
                            console.error('[library] detail open failed', error);
                            if (typeof showToast === 'function') showToast('歌单详情打开失败', true);
                        });
                    };
                    const deleteButton = makeLibraryActionButton('删除歌单「' + pl.name + '」', 'fa-trash', 'music-library-action-button', '删除');
                    deleteButton.style.color = '#ffb5b5';
                    deleteButton.onclick = async function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!confirm('删除歌单「' + pl.name + '」？')) return;
                        try {
                            await deleteUserPlaylist(pl.id);
                            await refreshMyPlaylists();
                            await refreshPlaylistTrash();
                            if (typeof showToast === 'function') showToast('已移至回收站，可在 30 天内恢复');
                        } catch (error) {
                            console.error(error);
                            if (typeof showToast === 'function') showToast('删除失败：浏览器存储不可用', true);
                        }
                    };
                    actions.appendChild(playButton);
                    actions.appendChild(manageButton);
                    actions.appendChild(deleteButton);
                    row.appendChild(cover);
                    row.appendChild(info);
                    row.appendChild(actions);
                    box.appendChild(row);
                });
            } catch (error) {
                console.error('[library] playlist render failed', error);
                box.innerHTML = '<div class="p-4 text-center text-red-300 text-sm">歌单加载失败</div>';
            }
        }

        function formatRecentPlayedAt(timestamp) {
            if (!timestamp) return '最近播放';
            const date = new Date(timestamp);
            if (!Number.isFinite(date.getTime())) return '最近播放';
            const now = new Date();
            if (date.toDateString() === now.toDateString()) {
                return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
            return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
        }

        function playRecentSong(song) {
            let index = playlist.findIndex(function (item) {
                return String(typeof item === 'object' ? item.id : item) === String(song.id);
            });
            if (index < 0) index = window.addSongToQueueOnly(song, { toast: false });
            if (index < 0) {
                if (typeof showToast === 'function') showToast('无法加入播放列表', true);
                return;
            }
            closeMyPlaylists();
            window.playSongAtIndex(index);
        }

        function refreshRecentHistory() {
            const box = document.getElementById('recentHistoryList');
            if (!box) return;
            const history = readRecentHistory();
            const count = document.getElementById('libraryRecentCount');
            if (count) count.textContent = String(history.length);
            const clearButton = document.getElementById('clearRecentHistoryBtn');
            if (clearButton) clearButton.disabled = history.length === 0;
            box.innerHTML = '';
            if (!history.length) {
                box.innerHTML = '<div class="h-full min-h-40 flex items-center justify-center text-center opacity-50 text-sm">还没有最近播放</div>';
                return;
            }
            history.forEach(function (song) {
                const row = document.createElement('div');
                row.className = 'music-library-row music-library-recent-row';
                const cover = document.createElement('div');
                cover.className = 'music-library-cover';
                if (song.cover) {
                    const image = document.createElement('img');
                    image.src = song.cover.replace(/^http:/, 'https:');
                    image.alt = '';
                    image.loading = 'lazy';
                    image.width = 44;
                    image.height = 44;
                    image.decoding = 'async';
                    image.onerror = function () {
                        cover.innerHTML = '<i class="fas fa-music opacity-40" aria-hidden="true"></i>';
                    };
                    cover.appendChild(image);
                } else {
                    cover.innerHTML = '<i class="fas fa-music opacity-40" aria-hidden="true"></i>';
                }
                const info = document.createElement('div');
                info.className = 'min-w-0';
                const title = document.createElement('div');
                title.className = 'font-medium truncate';
                title.textContent = song.name;
                const detail = document.createElement('div');
                detail.className = 'text-xs opacity-50 truncate mt-1';
                detail.textContent = song.artist + ' · ' + formatRecentPlayedAt(song.playedAt);
                info.appendChild(title);
                info.appendChild(detail);
                const actions = document.createElement('div');
                actions.className = 'music-library-row-actions flex items-center';
                const playButton = makeLibraryActionButton('播放「' + song.name + '」', 'fa-play');
                playButton.onclick = function () { playRecentSong(song); };
                actions.appendChild(playButton);
                row.appendChild(cover);
                row.appendChild(info);
                row.appendChild(actions);
                box.appendChild(row);
            });
        }

        function switchLibraryTab(tab) {
            activeLibraryTab = tab === 'recent' || tab === 'trash' ? tab : 'playlists';
            const isPlaylists = activeLibraryTab === 'playlists';
            const isRecent = activeLibraryTab === 'recent';
            const isTrash = activeLibraryTab === 'trash';
            const playlistTab = document.getElementById('libraryPlaylistsTab');
            const recentTab = document.getElementById('libraryRecentTab');
            const trashTab = document.getElementById('libraryTrashTab');
            const playlistPanel = document.getElementById('libraryPlaylistsPanel');
            const recentPanel = document.getElementById('libraryRecentPanel');
            const trashPanel = document.getElementById('libraryTrashPanel');
            if (playlistPanel) playlistPanel.classList.toggle('hidden', !isPlaylists);
            if (recentPanel) recentPanel.classList.toggle('hidden', !isRecent);
            if (trashPanel) trashPanel.classList.toggle('hidden', !isTrash);
            setAccessibleTabState(playlistTab, playlistPanel, isPlaylists);
            setAccessibleTabState(recentTab, recentPanel, isRecent);
            setAccessibleTabState(trashTab, trashPanel, isTrash);
            if (isPlaylists) refreshMyPlaylists();
            else if (isRecent) refreshRecentHistory();
            else refreshPlaylistTrash();
        }

        async function handlePlaylistBackupInput(file) {
            const importButton = document.getElementById('playlistBackupImportBtn');
            if (importButton) importButton.disabled = true;
            try {
                const records = await importPlaylistBackupFile(file);
                await refreshMyPlaylists();
                if (typeof showToast === 'function') showToast('已导入 ' + records.length + ' 个歌单');
            } catch (error) {
                console.error('[backup] import failed', error);
                if (typeof showToast === 'function') showToast(error.message || '歌单导入失败', true);
            } finally {
                if (importButton) importButton.disabled = false;
            }
        }

        function openMyPlaylists(tab) {
            const modal = document.getElementById('myPlaylistsModal');
            if (!modal) return;
            modal.classList.remove('hidden');
            switchLibraryTab(tab || activeLibraryTab);
            refreshRecentHistory();
            refreshPlaylistTrash();
            openAccessibleOverlay(modal, {
                close: closeMyPlaylists,
                initialFocus: '#closeMyPlaylistsBtn'
            });
        }

        function closeMyPlaylists() {
            const modal = document.getElementById('myPlaylistsModal');
            if (!modal) return;
            modal.classList.add('hidden');
            closeAccessibleOverlay(modal);
        }
        window.openMyPlaylists = openMyPlaylists;
        window.closeMyPlaylists = closeMyPlaylists;
        window.refreshMyPlaylists = refreshMyPlaylists;
        window.refreshRecentHistory = refreshRecentHistory;
        window.refreshPlaylistTrash = refreshPlaylistTrash;

        let currentHistoryPlaylistId = '';
        let playlistHistoryEntries = [];
        let playlistHistoryLoadToken = 0;

        function formatPlaylistVersionTime(timestamp) {
            const date = new Date(timestamp);
            if (!Number.isFinite(date.getTime())) return '时间未知';
            return date.toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        }

        function playlistVersionReasonLabel(reason) {
            if (reason === 'restore') return '恢复前';
            if (reason === 'delete') return '删除前';
            if (reason === 'remote') return '云端版本';
            return '修改前';
        }

        function renderPlaylistHistoryPreview(version) {
            const box = document.getElementById('playlistHistoryPreview');
            const status = document.getElementById('playlistHistoryStatus');
            if (!box) return;
            box.innerHTML = '';
            if (!version) {
                box.innerHTML = '<div class="h-full min-h-32 flex items-center justify-center text-center text-sm opacity-50">先选择一个版本预览</div>';
                return;
            }
            const heading = document.createElement('div');
            heading.className = 'flex items-start justify-between gap-3 mb-3';
            const info = document.createElement('div');
            info.className = 'min-w-0';
            const title = document.createElement('div');
            title.className = 'font-semibold break-words';
            title.textContent = version.name;
            const detail = document.createElement('div');
            detail.className = 'text-xs opacity-55 mt-1';
            detail.textContent = formatPlaylistVersionTime(version.createdAt) + ' · ' + version.songs.length + ' 首';
            info.appendChild(title);
            info.appendChild(detail);
            const restoreButton = makeLibraryActionButton(
                '恢复这个历史版本',
                'fa-history',
                'music-library-action-button',
                '恢复此版本'
            );
            restoreButton.onclick = async function () {
                if (!confirm('恢复到这个版本？\n当前歌单会先自动保存到历史中，不会静默丢失。')) return;
                restoreButton.disabled = true;
                if (status) status.textContent = '正在恢复历史版本';
                try {
                    await restorePlaylistVersion(currentHistoryPlaylistId, version);
                    await Promise.all([
                        refreshPlaylistHistory(),
                        refreshPlaylistDetailList(),
                        refreshMyPlaylists()
                    ]);
                    showToast('历史版本已恢复，恢复前内容仍保留在历史中');
                    if (status) status.textContent = '历史版本已恢复';
                } catch (error) {
                    console.error('[playlist-history] restore failed', error);
                    showToast(error.message || '历史版本恢复失败', true);
                    if (status) status.textContent = '历史版本恢复失败';
                } finally {
                    restoreButton.disabled = false;
                }
            };
            heading.appendChild(info);
            heading.appendChild(restoreButton);
            box.appendChild(heading);
            const songs = document.createElement('div');
            songs.className = 'space-y-1';
            if (!version.songs.length) {
                songs.innerHTML = '<div class="py-6 text-center text-sm opacity-50">这个版本没有歌曲</div>';
            } else {
                version.songs.forEach(function (rawSong, index) {
                    const song = getPlaylistDetailSong(rawSong);
                    const row = document.createElement('div');
                    row.className = 'flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm';
                    const number = document.createElement('span');
                    number.className = 'w-6 flex-none text-right opacity-35';
                    number.textContent = String(index + 1);
                    const text = document.createElement('div');
                    text.className = 'min-w-0';
                    const name = document.createElement('div');
                    name.className = 'truncate';
                    name.textContent = song.name;
                    const artist = document.createElement('div');
                    artist.className = 'truncate text-xs opacity-45';
                    artist.textContent = song.artist;
                    text.appendChild(name);
                    text.appendChild(artist);
                    row.appendChild(number);
                    row.appendChild(text);
                    songs.appendChild(row);
                });
            }
            box.appendChild(songs);
        }

        async function refreshPlaylistHistory() {
            const playlistId = currentHistoryPlaylistId;
            const box = document.getElementById('playlistHistoryList');
            const status = document.getElementById('playlistHistoryStatus');
            if (!box || !playlistId) return;
            const token = ++playlistHistoryLoadToken;
            box.innerHTML = '<div class="p-6 text-center text-sm opacity-50">正在加载历史版本...</div>';
            renderPlaylistHistoryPreview(null);
            if (status) status.textContent = '正在加载历史版本';
            try {
                const versions = await loadPlaylistVersions(playlistId);
                if (token !== playlistHistoryLoadToken || playlistId !== currentHistoryPlaylistId) return;
                playlistHistoryEntries = versions;
                box.innerHTML = '';
                if (!versions.length) {
                    box.innerHTML = '<div class="h-full min-h-32 flex items-center justify-center text-center text-sm opacity-50">还没有历史版本<br>修改歌单后会自动保存</div>';
                    if (status) status.textContent = '没有历史版本';
                    return;
                }
                versions.forEach(function (version) {
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'w-full min-h-[44px] flex items-center justify-between gap-3 rounded-xl px-3 py-2 mb-2 bg-white/5 hover:bg-white/10 text-left';
                    row.setAttribute('aria-label', '预览 ' + formatPlaylistVersionTime(version.createdAt) + ' 的版本');
                    const info = document.createElement('span');
                    info.className = 'min-w-0';
                    const time = document.createElement('span');
                    time.className = 'block text-sm font-medium';
                    time.textContent = formatPlaylistVersionTime(version.createdAt);
                    const detail = document.createElement('span');
                    detail.className = 'block text-xs opacity-50 mt-0.5';
                    detail.textContent = playlistVersionReasonLabel(version.reason) + ' · ' + version.songs.length + ' 首';
                    info.appendChild(time);
                    info.appendChild(detail);
                    const icon = document.createElement('i');
                    icon.className = 'fas fa-chevron-right opacity-45';
                    icon.setAttribute('aria-hidden', 'true');
                    row.appendChild(info);
                    row.appendChild(icon);
                    row.onclick = function () {
                        box.querySelectorAll('button').forEach(function (button) {
                            button.removeAttribute('aria-current');
                            button.classList.remove('ring-1', 'ring-white/40');
                        });
                        row.setAttribute('aria-current', 'true');
                        row.classList.add('ring-1', 'ring-white/40');
                        renderPlaylistHistoryPreview(version);
                        if (status) status.textContent = '正在预览 ' + formatPlaylistVersionTime(version.createdAt) + ' 的版本';
                    };
                    box.appendChild(row);
                });
                if (status) status.textContent = '已加载 ' + versions.length + ' 个历史版本';
            } catch (error) {
                console.error('[playlist-history] load failed', error);
                if (token !== playlistHistoryLoadToken) return;
                box.innerHTML = '<div class="p-6 text-center text-sm text-red-300">历史版本加载失败，请重试</div>';
                if (status) status.textContent = '历史版本加载失败';
            }
        }

        let pendingRecoveryImport = null;
        let recoveryImportPreviewBusy = false;

        function renderRecoveryImportPreview(summary) {
            const values = {
                active: summary && Number.isFinite(summary.activeCount) ? summary.activeCount : 0,
                trash: summary && Number.isFinite(summary.trashCount) ? summary.trashCount : 0,
                history: summary && Number.isFinite(summary.historyCount) ? summary.historyCount : 0,
                conflicts: summary && Number.isFinite(summary.conflictCount) ? summary.conflictCount : 0
            };
            Object.keys(values).forEach(function (key) {
                const element = document.getElementById('recoveryImportPreview' + key.charAt(0).toUpperCase() + key.slice(1));
                if (element) element.textContent = String(values[key]);
            });
            const status = document.getElementById('recoveryImportPreviewStatus');
            if (status) status.textContent = '等待确认';
        }

        function openRecoveryImportPreview(parsed, plan) {
            const modal = document.getElementById('recoveryImportPreviewModal');
            if (!modal) throw new Error('恢复包预览窗口缺失，请强刷');
            pendingRecoveryImport = { parsed: parsed, plan: plan };
            renderRecoveryImportPreview(plan.summary);
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
            openAccessibleOverlay(modal, {
                close: closeRecoveryImportPreview,
                initialFocus: '#recoveryImportPreviewCancelBtn'
            });
        }

        function closeRecoveryImportPreview() {
            if (recoveryImportPreviewBusy) return;
            const modal = document.getElementById('recoveryImportPreviewModal');
            pendingRecoveryImport = null;
            if (!modal) return;
            modal.style.display = 'none';
            modal.classList.add('hidden');
            const status = document.getElementById('recoveryImportPreviewStatus');
            if (status) status.textContent = '';
            closeAccessibleOverlay(modal);
        }

        async function confirmRecoveryImport() {
            if (!pendingRecoveryImport) return;
            const confirmButton = document.getElementById('recoveryImportPreviewConfirmBtn');
            const cancelButton = document.getElementById('recoveryImportPreviewCancelBtn');
            const cancelBottomButton = document.getElementById('recoveryImportPreviewCancelBtnBottom');
            const status = document.getElementById('recoveryImportPreviewStatus');
            recoveryImportPreviewBusy = true;
            if (confirmButton) confirmButton.disabled = true;
            if (cancelButton) cancelButton.disabled = true;
            if (cancelBottomButton) cancelBottomButton.disabled = true;
            if (status) status.textContent = '正在读取当前歌单并准备恢复，请稍候…';
            try {
                const parsed = pendingRecoveryImport.parsed;
                const plan = await createRecoveryImportPlan(parsed);
                const result = await commitRecoveryImportPlan(plan);
                recoveryImportPreviewBusy = false;
                closeRecoveryImportPreview();
                await refreshMyPlaylists();
                await refreshPlaylistTrash();
                if (typeof showToast === 'function') {
                    showToast('已恢复 ' + result.records.length + ' 个歌单，' + result.historyCount + ' 个历史版本');
                }
            } catch (error) {
                console.error('[recovery] import failed', error);
                if (status) status.textContent = error.message || '恢复包导入失败';
                if (typeof showToast === 'function') showToast(error.message || '恢复包导入失败', true);
            } finally {
                recoveryImportPreviewBusy = false;
                if (confirmButton) confirmButton.disabled = false;
                if (cancelButton) cancelButton.disabled = false;
                if (cancelBottomButton) cancelBottomButton.disabled = false;
            }
        }

        async function handleRecoveryPackageInput(file) {
            const importButton = document.getElementById('recoveryPackageImportBtn');
            if (importButton) importButton.disabled = true;
            try {
                const parsed = await readRecoveryPackageFile(file);
                const plan = await createRecoveryImportPlan(parsed);
                openRecoveryImportPreview(parsed, plan);
            } catch (error) {
                console.error('[recovery] preview failed', error);
                if (typeof showToast === 'function') showToast(error.message || '恢复包导入失败', true);
            } finally {
                if (importButton) importButton.disabled = false;
            }
        }

        function openPlaylistHistory() {
            const modal = document.getElementById('playlistHistoryModal');
            if (!modal || !currentDetailPlaylistId) return;
            currentHistoryPlaylistId = currentDetailPlaylistId;
            playlistHistoryEntries = [];
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
            openAccessibleOverlay(modal, {
                close: closePlaylistHistory,
                initialFocus: '#closePlaylistHistoryBtn'
            });
            void refreshPlaylistHistory();
        }

        function closePlaylistHistory() {
            const modal = document.getElementById('playlistHistoryModal');
            if (!modal) return;
            playlistHistoryLoadToken += 1;
            currentHistoryPlaylistId = '';
            playlistHistoryEntries = [];
            modal.style.display = 'none';
            modal.classList.add('hidden');
            closeAccessibleOverlay(modal);
        }

        function bindPlaylistHistoryUI() {
            const modal = document.getElementById('playlistHistoryModal');
            if (!modal || modal.dataset.bound === '1') return;
            modal.dataset.bound = '1';
            const closeButton = document.getElementById('closePlaylistHistoryBtn');
            if (closeButton) closeButton.addEventListener('click', closePlaylistHistory);
            modal.addEventListener('click', function (event) {
                if (event.target === modal) closePlaylistHistory();
            });
        }

        // ===== User playlist detail management =====
        let currentDetailPlaylistId = '';
        let playlistDetailBusy = false;

        async function getUserPlaylistById(playlistId) {
            const list = await listUserPlaylists();
            return list.find(function (item) { return item.id === playlistId; }) || null;
        }

        function getPlaylistDetailSong(song) {
            const isObject = song && typeof song === 'object';
            const id = isObject ? song.id : song;
            return {
                raw: song,
                id: id,
                name: isObject && song.name ? song.name : (id != null ? '歌曲 ID: ' + id : '未知歌曲'),
                artist: isObject ? (song.artist || song.artists || '未知艺术家') : '未知艺术家',
                cover: isObject ? (song.cover || song.picUrl || '') : ''
            };
        }

        function syncPlaylistDetailActionState() {
            const modal = document.getElementById('playlistDetailModal');
            if (!modal) return;
            modal.setAttribute('aria-busy', playlistDetailBusy ? 'true' : 'false');
            modal.querySelectorAll('[data-detail-action]').forEach(function (button) {
                button.disabled = playlistDetailBusy || button.dataset.unavailable === '1';
            });
        }

        function setPlaylistDetailBusy(isBusy) {
            playlistDetailBusy = !!isBusy;
            syncPlaylistDetailActionState();
        }

        function createPlaylistDetailButton(action, iconClass, label, unavailable, handler) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'playlist-detail-icon-button';
            button.dataset.detailAction = action;
            button.dataset.unavailable = unavailable ? '1' : '0';
            button.setAttribute('aria-label', label);
            button.title = label;
            button.disabled = playlistDetailBusy || unavailable;
            const icon = document.createElement('i');
            icon.className = 'fas ' + iconClass;
            icon.setAttribute('aria-hidden', 'true');
            button.appendChild(icon);
            button.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                if (!button.disabled) handler();
            });
            return button;
        }

        async function refreshPlaylistDetailList() {
            const requestedId = currentDetailPlaylistId;
            const box = document.getElementById('playlistDetailList');
            const title = document.getElementById('playlistDetailTitle');
            const count = document.getElementById('playlistDetailCount');
            const status = document.getElementById('playlistDetailStatus');
            const playAllButton = document.getElementById('playlistDetailPlayBtn');
            if (!box || !requestedId) return;

            box.innerHTML = '<div class="p-6 text-center text-sm opacity-50">正在加载歌单...</div>';
            if (status) status.textContent = '';
            if (playAllButton) {
                playAllButton.dataset.unavailable = '1';
                syncPlaylistDetailActionState();
            }

            try {
                const target = await getUserPlaylistById(requestedId);
                if (currentDetailPlaylistId !== requestedId) return;
                if (!target) {
                    if (title) title.textContent = '歌单不存在';
                    if (count) count.textContent = '';
                    box.innerHTML = '<div class="p-6 text-center text-sm opacity-50">该歌单可能已被删除</div>';
                    return;
                }

                const songs = Array.isArray(target.songs) ? target.songs : [];
                if (title) title.textContent = target.name || '未命名歌单';
                if (count) count.textContent = songs.length + ' 首';
                if (playAllButton) {
                    playAllButton.dataset.unavailable = songs.length ? '0' : '1';
                    syncPlaylistDetailActionState();
                }
                if (!songs.length) {
                    box.innerHTML = '<div class="p-6 text-center text-sm opacity-50">歌单为空，可从搜索结果加入歌曲</div>';
                    return;
                }

                box.innerHTML = '';
                const fragment = document.createDocumentFragment();
                songs.forEach(function (rawSong, index) {
                    const song = getPlaylistDetailSong(rawSong);
                    const row = document.createElement('div');
                    row.className = 'playlist-detail-row';
                    row.dataset.songIndex = String(index);

                    const cover = document.createElement('div');
                    cover.className = 'playlist-detail-cover';
                    if (song.cover) {
                        const image = document.createElement('img');
                        image.alt = '';
                        image.loading = 'lazy';
                        image.width = 40;
                        image.height = 40;
                        image.decoding = 'async';
                        const separator = String(song.cover).includes('?') ? '&' : '?';
                        const coverUrl = String(song.cover) + separator + 'param=80y80';
                        image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        if (typeof window.getCachedImage === 'function') {
                            window.getCachedImage(coverUrl).then(function (cachedUrl) {
                                if (image.isConnected) image.src = cachedUrl;
                            }).catch(function () { if (image.isConnected) image.src = coverUrl; });
                        } else {
                            image.src = coverUrl;
                        }
                        image.onerror = function () { image.style.display = 'none'; };
                        cover.appendChild(image);
                    } else {
                        cover.innerHTML = '<i class="fas fa-music opacity-35" aria-hidden="true"></i>';
                    }

                    const info = document.createElement('div');
                    info.className = 'min-w-0';
                    const songName = document.createElement('div');
                    songName.className = 'truncate text-sm font-semibold';
                    songName.textContent = song.name;
                    const artist = document.createElement('div');
                    artist.className = 'truncate text-xs opacity-50';
                    artist.textContent = song.artist;
                    info.appendChild(songName);
                    info.appendChild(artist);

                    const actions = document.createElement('div');
                    actions.className = 'playlist-detail-actions';
                    actions.appendChild(createPlaylistDetailButton('play', 'fa-play', '播放 ' + song.name, song.id == null, function () {
                        const normalized = normalizeSongObject(rawSong);
                        const targetIndex = normalized && normalized.id != null ? window.addSongToQueueOnly(normalized, { toast: false }) : -1;
                        if (targetIndex < 0) {
                            if (typeof showToast === 'function') showToast('歌曲信息不完整，无法播放', true);
                            return;
                        }
                        if (typeof window.playSongAtIndex === 'function') window.playSongAtIndex(targetIndex);
                        closePlaylistDetail();
                    }));
                    actions.appendChild(createPlaylistDetailButton('up', 'fa-arrow-up', '上移 ' + song.name, index === 0, function () {
                        movePlaylistDetailSong(index, -1);
                    }));
                    actions.appendChild(createPlaylistDetailButton('down', 'fa-arrow-down', '下移 ' + song.name, index === songs.length - 1, function () {
                        movePlaylistDetailSong(index, 1);
                    }));
                    actions.appendChild(createPlaylistDetailButton('remove', 'fa-trash', '从歌单移除 ' + song.name, false, function () {
                        if (!confirm('从歌单移除「' + song.name + '」？')) return;
                        removePlaylistDetailSong(index);
                    }));

                    row.appendChild(cover);
                    row.appendChild(info);
                    row.appendChild(actions);
                    fragment.appendChild(row);
                });
                box.appendChild(fragment);
            } catch (error) {
                console.error('[playlist detail] load failed', error);
                if (currentDetailPlaylistId !== requestedId) return;
                box.innerHTML = '<div class="p-6 text-center text-sm text-red-300">歌单加载失败，请重试</div>';
                if (status) status.textContent = '歌单加载失败';
            }
        }

        async function mutatePlaylistDetail(mutator, successMessage) {
            const playlistId = currentDetailPlaylistId;
            if (!playlistId || playlistDetailBusy) return;
            setPlaylistDetailBusy(true);
            let changed = false;
            try {
                const target = await getUserPlaylistById(playlistId);
                if (!target) throw new Error('歌单不存在');
                const songs = Array.isArray(target.songs) ? target.songs.slice() : [];
                changed = mutator(songs) === true;
                if (changed) {
                    target.songs = songs;
                    await saveUserPlaylistRecord(target);
                    if (typeof showToast === 'function' && successMessage) showToast(successMessage);
                }
            } catch (error) {
                console.error('[playlist detail] save failed', error);
                if (typeof showToast === 'function') showToast('保存歌单失败，请重试', true);
            } finally {
                if (currentDetailPlaylistId === playlistId) {
                    try { await refreshPlaylistDetailList(); } catch (error) { console.error(error); }
                }
                if (changed) {
                    try { await refreshMyPlaylists(); } catch (error) { console.error(error); }
                    try { await refreshUserPlaylistLibrary(); } catch (error) { console.error(error); }
                }
                setPlaylistDetailBusy(false);
            }
        }

        function movePlaylistDetailSong(index, offset) {
            return mutatePlaylistDetail(function (songs) {
                const targetIndex = index + offset;
                if (index < 0 || index >= songs.length || targetIndex < 0 || targetIndex >= songs.length) return false;
                const currentSong = songs[index];
                songs[index] = songs[targetIndex];
                songs[targetIndex] = currentSong;
                return true;
            }, offset < 0 ? '歌曲已上移' : '歌曲已下移');
        }

        function removePlaylistDetailSong(index) {
            return mutatePlaylistDetail(function (songs) {
                if (index < 0 || index >= songs.length) return false;
                songs.splice(index, 1);
                return true;
            }, '已从歌单移除');
        }

        async function playCurrentDetailPlaylist() {
            const playlistId = currentDetailPlaylistId;
            if (!playlistId || playlistDetailBusy) return;
            try {
                await loadUserPlaylistIntoQueue(playlistId, true);
                closePlaylistDetail();
            } catch (error) {
                console.error('[playlist detail] play failed', error);
                if (typeof showToast === 'function') showToast('播放歌单失败', true);
            }
        }

        async function openPlaylistDetail(playlistId) {
            const modal = document.getElementById('playlistDetailModal');
            if (!modal || !playlistId) return;
            currentDetailPlaylistId = playlistId;
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
            await refreshPlaylistDetailList();
            openAccessibleOverlay(modal, {
                close: closePlaylistDetail,
                initialFocus: '#closePlaylistDetailBtn'
            });
        }

        function closePlaylistDetail() {
            const modal = document.getElementById('playlistDetailModal');
            if (!modal) return;
            modal.style.display = 'none';
            modal.classList.add('hidden');
            currentDetailPlaylistId = '';
            closeAccessibleOverlay(modal);
        }

        function bindPlaylistDetailUI() {
            const modal = document.getElementById('playlistDetailModal');
            if (!modal || modal.dataset.bound === '1') return;
            modal.dataset.bound = '1';
            const closeButton = document.getElementById('closePlaylistDetailBtn');
            const playButton = document.getElementById('playlistDetailPlayBtn');
            const historyButton = document.getElementById('playlistDetailHistoryBtn');
            if (closeButton) closeButton.addEventListener('click', closePlaylistDetail);
            if (playButton) playButton.addEventListener('click', playCurrentDetailPlaylist);
            if (historyButton) historyButton.addEventListener('click', openPlaylistHistory);
            modal.addEventListener('click', function (event) {
                if (event.target === modal) closePlaylistDetail();
            });
        }

        window.openPlaylistDetail = openPlaylistDetail;
        window.closePlaylistDetail = closePlaylistDetail;
        window.refreshPlaylistDetailList = refreshPlaylistDetailList;

        function clearCurrentQueue() {
            if (!playlist.length) {
                resetPlaybackIdentity();
                currentPlaylistId = '';
                playlistSource = 'empty';
                playlistSourceName = '已清空';
                removeLocalStorage('cp_playlistId');
                scheduleSaveCurrentQueue('clear_empty');
                if (typeof showToast === 'function') showToast('播放列表已为空');
                return;
            }
            if (!confirm('清空当前播放列表？')) return;
            playlist = [];
            window.playlist = playlist;
            currentIndex = -1;
            resetPlaybackIdentity();
            currentPlaylistId = '';
            playlistSource = 'empty';
            playlistSourceName = '已清空';
            removeLocalStorage('cp_playlistId');
            shuffledOrder = [];
            playlistTotalCount = 0;
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (typeof mobileUI !== 'undefined' && mobileUI && typeof mobileUI.loadPlaylist === 'function') mobileUI.loadPlaylist();
            scheduleSaveCurrentQueue('clear');
            if (typeof showToast === 'function') showToast('已清空播放列表');
        }

        function bindUserPlaylistUI() {
            if (window.__userPlaylistUIBound) return;
            window.__userPlaylistUIBound = true;
            document.addEventListener('click', async function (event) {
                const target = event.target;
                if (!target || !target.closest) return;

                if (target.closest('#closeUserPlaylistModal')) {
                    event.preventDefault();
                    closeAddToPlaylistModal();
                    return;
                }
                if (target.closest('#createPlaylistInModalBtn')) {
                    event.preventDefault();
                    try {
                        const input = document.getElementById('modalNewPlaylistName');
                        const created = await createUserPlaylist(input ? input.value.trim() : '');
                        if (input) input.value = '';
                        if (pendingSongForPlaylist) {
                            await addSongToUserPlaylist(created.id, pendingSongForPlaylist);
                            if (typeof showToast === 'function') showToast('已新建并加入: ' + created.name);
                            closeAddToPlaylistModal();
                        } else if (typeof showToast === 'function') {
                            showToast('歌单已创建');
                        }
                        await refreshUserPlaylistModalList();
                        await refreshMyPlaylists();
                    } catch (error) {
                        console.error('[playlist] create failed', error);
                        if (typeof showToast === 'function') showToast('创建失败', true);
                    }
                    return;
                }
                if (target.closest('#mClearQueueBtn, #mClearQueueBtnBar, #clearQueueBtn')) {
                    event.preventDefault();
                    clearCurrentQueue();
                    return;
                }
                if (target.closest('#settingsCreatePlaylistBtn')) {
                    event.preventDefault();
                    const input = document.getElementById('settingsCreatePlaylistName');
                    const name = input ? input.value.trim() : '';
                    if (!name) {
                        if (typeof showToast === 'function') showToast('请输入歌单名称', true);
                        return;
                    }
                    try {
                        await createUserPlaylist(name);
                        if (input) input.value = '';
                        await refreshMyPlaylists();
                        if (typeof showToast === 'function') showToast('已创建歌单');
                    } catch (error) {
                        console.error('[playlist] create failed', error);
                        if (typeof showToast === 'function') showToast('创建失败', true);
                    }
                    return;
                }
                if (target.closest('#musicLibraryBtn, #myPlaylistsBtn')) {
                    event.preventDefault();
                    openMyPlaylists();
                    return;
                }
                if (target.closest('#closeMyPlaylistsBtn')) {
                    event.preventDefault();
                    closeMyPlaylists();
                    return;
                }
                if (target.closest('#libraryPlaylistsTab')) {
                    event.preventDefault();
                    switchLibraryTab('playlists');
                    return;
                }
                if (target.closest('#libraryRecentTab')) {
                    event.preventDefault();
                    switchLibraryTab('recent');
                    return;
                }
                if (target.closest('#libraryTrashTab')) {
                    event.preventDefault();
                    switchLibraryTab('trash');
                    return;
                }
                if (target.closest('#myCreatePlaylistBtn')) {
                    event.preventDefault();
                    const input = document.getElementById('myNewPlaylistName');
                    const name = input ? input.value.trim() : '';
                    if (!name) {
                        if (typeof showToast === 'function') showToast('请输入歌单名称', true);
                        return;
                    }
                    try {
                        await createUserPlaylist(name);
                        if (input) input.value = '';
                        await refreshMyPlaylists();
                        if (typeof showToast === 'function') showToast('歌单已创建');
                    } catch (error) {
                        console.error('[playlist] create failed', error);
                        if (typeof showToast === 'function') showToast('创建失败', true);
                    }
                    return;
                }
                if (target.closest('#playlistBackupExportBtn')) {
                    event.preventDefault();
                    const button = document.getElementById('playlistBackupExportBtn');
                    if (button) button.disabled = true;
                    try {
                        const count = await downloadPlaylistBackup();
                        if (typeof showToast === 'function') showToast('已导出 ' + count + ' 个歌单');
                    } catch (error) {
                        console.error('[backup] export failed', error);
                        if (typeof showToast === 'function') showToast('歌单导出失败', true);
                    } finally {
                        if (button) button.disabled = false;
                    }
                    return;
                }
                if (target.closest('#playlistBackupImportBtn')) {
                    event.preventDefault();
                    const input = document.getElementById('playlistBackupInput');
                    if (input) input.click();
                    return;
                }
                if (target.closest('#recoveryPackageExportBtn')) {
                    event.preventDefault();
                    const button = document.getElementById('recoveryPackageExportBtn');
                    if (button) button.disabled = true;
                    try {
                        const result = await downloadRecoveryPackage();
                        if (typeof showToast === 'function') showToast('已导出 ' + result.playlistCount + ' 个歌单和 ' + result.historyCount + ' 个历史版本');
                    } catch (error) {
                        console.error('[recovery] export failed', error);
                        if (typeof showToast === 'function') showToast(error.message || '恢复包导出失败', true);
                    } finally {
                        if (button) button.disabled = false;
                    }
                    return;
                }
                if (target.closest('#recoveryPackageImportBtn')) {
                    event.preventDefault();
                    const input = document.getElementById('recoveryPackageInput');
                    if (input) input.click();
                    return;
                }
                if (target.closest('#clearRecentHistoryBtn')) {
                    event.preventDefault();
                    if (!readRecentHistory().length) return;
                    if (!confirm('清空最近播放记录？')) return;
                    clearRecentHistory();
                    if (typeof showToast === 'function') showToast('最近播放已清空');
                    return;
                }
                const libraryModal = document.getElementById('myPlaylistsModal');
                if (libraryModal && target === libraryModal) closeMyPlaylists();
            }, true);

            const backupInput = document.getElementById('playlistBackupInput');
            if (backupInput) {
                backupInput.addEventListener('change', async function () {
                    const file = backupInput.files && backupInput.files[0];
                    backupInput.value = '';
                    if (file) await handlePlaylistBackupInput(file);
                });
            }
            const recoveryInput = document.getElementById('recoveryPackageInput');
            if (recoveryInput) {
                recoveryInput.addEventListener('change', async function () {
                    const file = recoveryInput.files && recoveryInput.files[0];
                    recoveryInput.value = '';
                    if (file) await handleRecoveryPackageInput(file);
                });
            }
            const recoveryPreviewModal = document.getElementById('recoveryImportPreviewModal');
            const recoveryPreviewCancelButton = document.getElementById('recoveryImportPreviewCancelBtn');
            const recoveryPreviewCancelBottomButton = document.getElementById('recoveryImportPreviewCancelBtnBottom');
            const recoveryPreviewConfirmButton = document.getElementById('recoveryImportPreviewConfirmBtn');
            if (recoveryPreviewCancelButton) recoveryPreviewCancelButton.addEventListener('click', closeRecoveryImportPreview);
            if (recoveryPreviewCancelBottomButton) recoveryPreviewCancelBottomButton.addEventListener('click', closeRecoveryImportPreview);
            if (recoveryPreviewConfirmButton) recoveryPreviewConfirmButton.addEventListener('click', function () {
                void confirmRecoveryImport();
            });
            if (recoveryPreviewModal) recoveryPreviewModal.addEventListener('click', function (event) {
                if (event.target === recoveryPreviewModal) closeRecoveryImportPreview();
            });
            [
                ['myNewPlaylistName', 'myCreatePlaylistBtn'],
                ['settingsCreatePlaylistName', 'settingsCreatePlaylistBtn'],
                ['modalNewPlaylistName', 'createPlaylistInModalBtn']
            ].forEach(function (pair) {
                const input = document.getElementById(pair[0]);
                const button = document.getElementById(pair[1]);
                if (!input || !button) return;
                input.addEventListener('keydown', function (event) {
                    if (event.key !== 'Enter' || event.isComposing) return;
                    event.preventDefault();
                    button.click();
                });
            });
            const libraryTabList = document.querySelector('[aria-label="音乐资料库视图"]');
            const libraryPlaylistsTab = document.getElementById('libraryPlaylistsTab');
            const libraryRecentTab = document.getElementById('libraryRecentTab');
            const libraryTrashTab = document.getElementById('libraryTrashTab');
            bindArrowTabNavigation(libraryTabList, [libraryPlaylistsTab, libraryRecentTab, libraryTrashTab], function (tab) {
                switchLibraryTab(tab === libraryRecentTab ? 'recent' : (tab === libraryTrashTab ? 'trash' : 'playlists'));
            });
            bindPlaylistDetailUI();
            bindPlaylistHistoryUI();
            refreshMyPlaylists();
            refreshRecentHistory();
            refreshPlaylistTrash();
        }
        window.bindUserPlaylistUI = bindUserPlaylistUI;


        // ================= 伪随机播放：打乱播放列表 =================
        function shufflePlaylist() {
            // Fisher-Yates 洗牌算法
            shuffledOrder = playlist.map((_, i) => i);
            for (let i = shuffledOrder.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffledOrder[i], shuffledOrder[j]] = [shuffledOrder[j], shuffledOrder[i]];
            }
            shuffledIndex = 0;
            console.log('🔀 播放列表已打乱');
        }

        function ensureShuffleOrder() {
            const valid = shuffledOrder.length === playlist.length &&
                shuffledOrder.every(function (index) { return Number.isInteger(index) && index >= 0 && index < playlist.length; });
            if (!valid) shufflePlaylist();
        }

        // Natural repeat-one keeps the current index. Manual navigation can opt out.
        function getNextSongIndex(options) {
            options = options || {};
            if (!playlist.length) return -1;
            if (currentIndex < 0) {
                if (playMode === 'shuffle') {
                    ensureShuffleOrder();
                    return shuffledOrder[0] ?? 0;
                }
                return 0;
            }
            if (playMode === 'repeat_one' && !options.ignoreRepeatOne) return currentIndex;
            if (playMode === 'shuffle') {
                ensureShuffleOrder();
                const currentPos = shuffledOrder.indexOf(currentIndex);
                return shuffledOrder[(Math.max(currentPos, -1) + 1) % shuffledOrder.length];
            }
            if (currentIndex + 1 < playlist.length) return currentIndex + 1;
            return playMode === 'repeat_all' ? 0 : -1;
        }

        function getPreviousSongIndex(options) {
            options = options || {};
            if (!playlist.length) return -1;
            if (currentIndex < 0) return 0;
            if (playMode === 'repeat_one' && !options.ignoreRepeatOne) return currentIndex;
            if (playMode === 'shuffle') {
                ensureShuffleOrder();
                const currentPos = shuffledOrder.indexOf(currentIndex);
                const safePos = currentPos < 0 ? 0 : currentPos;
                return shuffledOrder[(safePos - 1 + shuffledOrder.length) % shuffledOrder.length];
            }
            if (currentIndex > 0) return currentIndex - 1;
            return playMode === 'repeat_all' ? playlist.length - 1 : -1;
        }

        // ================= 无缝播放：预加载下一首 =================
        function discardPreloadedNextMedia() {
            preloadedNextMedia = null;
            try {
                preloadAudio.pause();
                preloadAudio.removeAttribute('src');
                preloadAudio.load();
            } catch (error) {}
        }

        function takePreloadedNextMedia(index) {
            const record = preloadedNextMedia;
            const song = index >= 0 && index < playlist.length ? playlist[index] : null;
            const songId = song && typeof song === 'object' ? song.id : song;
            const normalizedSongId = songId == null ? '' : String(songId);
            const matches = !!(record && record.status === 'ready' && committedMedia &&
                record.ownerToken === committedMedia.token && record.index === index &&
                record.songId === normalizedSongId && record.mediaUrl && record.data);
            if (!matches) {
                if (record) discardPreloadedNextMedia();
                return null;
            }
            preloadedNextMedia = null;
            return record;
        }

        async function preloadNextSong(ownerAttempt) {
            if (!ownerAttempt || !isAttemptCommitted(ownerAttempt) || !playlist.length || playMode === 'repeat_one') {
                discardPreloadedNextMedia();
                return false;
            }

            const nextIndex = getNextSongIndex();
            if (nextIndex < 0) {
                discardPreloadedNextMedia();
                return false;
            }
            const nextSong = playlist[nextIndex];
            const nextSongIdValue = typeof nextSong === 'object' ? nextSong.id : nextSong;
            const nextSongId = nextSongIdValue == null ? '' : String(nextSongIdValue);
            if (!nextSongId) {
                discardPreloadedNextMedia();
                return false;
            }

            if (preloadedNextMedia && preloadedNextMedia.ownerToken === ownerAttempt.token &&
                preloadedNextMedia.index === nextIndex && preloadedNextMedia.songId === nextSongId) {
                return preloadedNextMedia.status === 'ready';
            }

            const record = {
                ownerToken: ownerAttempt.token,
                index: nextIndex,
                songId: nextSongId,
                status: 'loading',
                data: null,
                mediaUrl: ''
            };
            preloadedNextMedia = record;

            try {
                const data = await musicService.getSong(nextSongIdValue);
                if (preloadedNextMedia !== record || !activePlaybackAttempt ||
                    activePlaybackAttempt.token !== ownerAttempt.token || !isAttemptCommitted(ownerAttempt)) return false;
                const currentNextIndex = getNextSongIndex();
                const currentNextSong = currentNextIndex >= 0 ? playlist[currentNextIndex] : null;
                const currentNextSongId = currentNextSong && typeof currentNextSong === 'object'
                    ? currentNextSong.id
                    : currentNextSong;
                if (currentNextIndex !== nextIndex || String(currentNextSongId ?? '') !== nextSongId) {
                    discardPreloadedNextMedia();
                    return false;
                }
                const mediaUrl = normalizePlayableUrl(data?.url);
                record.status = 'ready';
                record.data = data;
                record.mediaUrl = mediaUrl;
                preloadAudio.src = mediaUrl;
                preloadAudio.load();
                return true;
            } catch (error) {
                if (preloadedNextMedia === record) discardPreloadedNextMedia();
                return false;
            }
        }

        // ================= 音质分级识别 =================
        function renderPlaybackQuality(qualityInfo) {
            if (!qualityInfo) return;
            const label = qualityInfo.icon ? `${qualityInfo.icon} ${qualityInfo.text}` : qualityInfo.text;
            const ariaLabel = `当前播放音质：${qualityInfo.detail}`;
            document.querySelectorAll('#qualityBadge, #mobileQualityBadge').forEach((element) => {
                element.textContent = label;
                element.className = `quality-badge ${qualityInfo.className}`;
                element.title = qualityInfo.detail;
                element.setAttribute('aria-label', ariaLabel);
            });
        }

        // ================= 音量标准化 (ReplayGain 模拟) =================
        let compressorNode = null;

        function setupAudioNormalization() {
            // no-op: keep original loudness/timbre
        }

        // ================= 虚拟滚动配置 =================
        let renderedCount = 0;
        const CHUNK_SIZE = 50;  // 每次渲染的数量
        const ITEM_HEIGHT = 56; // 歌单项高度 (px)
        let virtualScrollEnabled = true;

        // 虚拟滚动状态
        let vsState = {
            scrollTop: 0,
            startIndex: 0,
            endIndex: 0,
            itemHeight: 56,  // 每个歌曲项的高度
            bufferCount: 5   // 缓冲区大小
        };


        // 主题色系统已移除，使用纯白色/灰色调极简风格
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        let dom = {};

        function markCPlayerReady() {
            document.documentElement.dataset.cplayerReady = 'true';
            window.dispatchEvent(new CustomEvent('cplayer:ready'));
        }

        document.addEventListener('DOMContentLoaded', async () => {
            document.querySelectorAll('[id]').forEach(el => dom[el.id] = el);
            dom.lyricsContainer = document.querySelector('.lyrics-container');
            dom.playlistContainer = document.getElementById('playlistContainer');
            dom.playlistContent = document.getElementById('playlistContent');
            dom.uploadContainer = document.querySelector('.upload-container');
            // dom.playlistInfo = document.querySelector('.playlist-info');
            dom.albumArtWrapper = document.getElementById('albumArtWrapper');
            dom.html = document.documentElement;
            // The search module reads these lazily through the object, so wiring it
            // right after dom is populated is enough; no search can run before this.
            configureSearchView({
                dom,
                musicService,
                renderAllPlaylistItems,
                showToast,
                playSongAtIndex: (index, options) => window.playSongAtIndex(index, options)
            });
            storageWarningUiReady = true;
            flushStorageWarning();

            // ★ 初始化 IndexedDB 缓存
            try {
                await initDatabase();
                console.log('💾 IndexedDB 缓存已初始化');
                await cleanupExpiredLocalTrash();
            } catch (e) {
                console.warn('IndexedDB 初始化失败:', e);
            }

            initEventListeners();
            setupConnectivityFeedback();
            const savedPlayMode = readLocalStorage('cp_play_mode');
            playMode = normalizePlayMode(savedPlayMode || playMode);
            writeLocalStorage('cp_play_mode', playMode);
            if (typeof updatePlayModeUI === 'function') updatePlayModeUI();
            initSettingsUI();
            setupSleepTimerUI();
            setupApiSettingsUI();
            setupPlaybackDiagnosticsUI();
            setupCloudAccountUI();
            setupPlaylistIdLoader();
            if (typeof bindUserPlaylistUI === 'function') bindUserPlaylistUI();  // 初始化歌单ID加载按钮
            await loadDefaultPlaylist();
            flushStorageWarning();
            setupServiceWorkerUpdates();
            setupReducedMotionPreference();
            initVisualizer();
            initCanvasRenderers();
            // checkSystemTheme(); // Removed
            // enableGradientModeByDefault(); // Removed

            // [需求4] 检测移动端并显示设置内的按钮
            // initMobileSettingsButtons(); // Removed

            updateVolumeIcon(0.5);

            setupMediaSessionHandlers();

            // H5+ Integration for Android App
            document.addEventListener('plusready', function () {
                // Keep CPU awake
                plus.device.setWakelock(true);

                // Handle physical back button
                plus.key.addEventListener('backbutton', function () {
                    // Move task to background
                    var main = plus.android.runtimeMainActivity();
                    main.moveTaskToBack(false);
                }, false);
            });

            markCPlayerReady();
            void initializeCloudAccount();
        });

        function initEventListeners() {
            initAccessibleOverlayManager();
            dom.searchButton.addEventListener('click', () => { if (!isMobileLayoutViewport() && typeof switchDesktopTab === 'function') switchDesktopTab('search'); searchSongs(dom.searchInput.value); });
            dom.searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { if (!isMobileLayoutViewport() && typeof switchDesktopTab === 'function') switchDesktopTab('search'); searchSongs(dom.searchInput.value); } });

            // Floating Toggle Button - opens sidebar
            document.getElementById('togglePlaylistBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                togglePlaylistPanel();
            });

            // Desktop Tab Switching
            const desktopTabPlaylist = document.getElementById('desktopTabPlaylist');
            const desktopTabSearch = document.getElementById('desktopTabSearch');
            if (desktopTabPlaylist) {
                desktopTabPlaylist.addEventListener('click', () => switchDesktopTab('playlist'));
            }
            if (desktopTabSearch) {
                desktopTabSearch.addEventListener('click', () => switchDesktopTab('search'));
            }
            bindArrowTabNavigation(desktopTabPlaylist && desktopTabPlaylist.parentElement,
                [desktopTabPlaylist, desktopTabSearch], function (tab) {
                    switchDesktopTab(tab === desktopTabSearch ? 'search' : 'playlist', false);
                });
            switchDesktopTab(desktopActiveTab);

            dom.playPauseBtn.addEventListener('click', togglePlayPause);
            dom.prevBtn.addEventListener('click', playPreviousSong);
            dom.nextBtn.addEventListener('click', playNextSong);
            dom.playModeBtn.addEventListener('click', cyclePlayMode);

            dom.progressBar.parentElement.parentElement.addEventListener('click', seekAudio);
            if (dom.progressBarContainer) dom.progressBarContainer.addEventListener('keydown', handleProgressKeydown);

            audio.addEventListener('timeupdate', updatePlayerState);
            audio.addEventListener('play', onPlayStart);
            audio.addEventListener('pause', onPlayPause);
            audio.addEventListener('ended', handleSongEnd);
            audio.addEventListener('error', handleAudioError);
            audio.addEventListener('loadedmetadata', () => {
                markCommittedMediaReady();
                dom.totalTime.textContent = formatTime(audio.duration);
                updatePlayerState();
            });

            dom.volumeSlider.addEventListener('input', (e) => {
                audio.volume = e.target.value;
                audio.muted = false;
                updateVolumeIcon(audio.volume);
            });

            dom.volumeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const popover = document.getElementById('volumePopover');
                if (popover.classList.contains('show')) {
                    audio.muted = !audio.muted;
                    updateVolumeIcon(audio.muted ? 0 : audio.volume);
                } else {
                    popover.classList.add('show');
                    popover.inert = false;
                    popover.setAttribute('aria-hidden', 'false');
                    dom.volumeBtn.setAttribute('aria-expanded', 'true');
                }
            });

            document.addEventListener('click', (e) => {
                const popover = document.getElementById('volumePopover');
                const btn = document.getElementById('volumeBtn');
                if (popover && btn && !popover.contains(e.target) && !btn.contains(e.target)) {
                    popover.classList.remove('show');
                    popover.setAttribute('aria-hidden', 'true');
                    popover.inert = true;
                    btn.setAttribute('aria-expanded', 'false');
                }

                // Close unified Sidebar
                const playlistPanel = document.getElementById('floatingPlaylistPanel');
                const playlistBtn = document.getElementById('togglePlaylistBtn');
                if (playlistPanel && !playlistPanel.classList.contains('translate-x-full') &&
                    !playlistPanel.contains(e.target) && (!playlistBtn || !playlistBtn.contains(e.target)) &&
                    !isOverlayInteractionTarget(e.target)) {
                    togglePlaylistPanel(false);
                }
            });

            dom.playlistFile.addEventListener('change', handlePlaylistUpload);
            dom.uploadContainer.addEventListener('click', (e) => {
                if (e.target.tagName !== "LABEL") dom.playlistFile.click();
            });
            dom.uploadContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                dom.uploadContainer.style.transform = "scale(1.02)";
            });
            dom.uploadContainer.addEventListener('drop', (e) => {
                e.preventDefault();
                dom.uploadContainer.style.transform = "scale(1)";
                if (e.dataTransfer.files[0]) handlePlaylistFile(e.dataTransfer.files[0]);
            });
            dom.uploadContainer.addEventListener('dragleave', () => {
                dom.uploadContainer.style.transform = "scale(1)";
            });

            // 滚动事件由 setupVirtualScroll 中的 onscroll 处理

            document.getElementById('fullscreenBtn').addEventListener('click', toggleFullScreen);

            // --- Gemini修复: 设置按钮逻辑增强 ---
            const safeSettingsBtn = document.getElementById('settingsBtn');
            if (safeSettingsBtn) {
                safeSettingsBtn.onclick = (e) => {
                    e.stopPropagation();
                    openSettings();
                };
            }

            // 移动端设置按钮
            const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
            if (mobileSettingsBtn) {
                mobileSettingsBtn.onclick = (e) => {
                    e.stopPropagation();
                    openSettings();
                };
            }

            dom.closeSettingsBtn.addEventListener('click', closeSettings);
            dom.settingsModal.addEventListener('click', (e) => {
                if (e.target === dom.settingsModal) closeSettings();
            });


            // Copy Interactions
            setupCopyInteraction('songTitle', () => dom.songTitle.textContent);
            setupCopyInteraction('artistName', () => dom.artistName.textContent);
            setupCopyInteraction('songIdTag', () => dom.songIdTag.textContent.replace('ID: ', ''));

            // Mobile Copy Interactions
            setupCopyInteraction('mobileTitle', () => dom.songTitle.textContent);
            setupCopyInteraction('mobileArtist', () => dom.artistName.textContent);
            setupCopyInteraction('mobileSongIdTag', () => dom.songIdTag.textContent.replace('ID: ', ''));

            // [需求4] 手机端设置按钮逻辑
            const settingsFullscreenBtn = document.getElementById('settingsFullscreenBtn');
            if (settingsFullscreenBtn) {
                settingsFullscreenBtn.onclick = () => {
                    toggleFullScreen();
                };
            }

            const mobileSettingsButtons = document.getElementById('mobileSettingsButtons');
            const updateMobileButtonsVisibility = () => {
                const isMobile = isMobileLayoutViewport();
                if (mobileSettingsButtons) {
                    if (isMobile) {
                        mobileSettingsButtons.classList.remove('hidden');
                    } else {
                        mobileSettingsButtons.classList.add('hidden');
                    }
                }
            };
            updateMobileButtonsVisibility();
            window.addEventListener('resize', updateMobileButtonsVisibility);
        }

        function focusDesktopSearchInput() {
            requestAnimationFrame(function () {
                const panel = document.getElementById('floatingPlaylistPanel');
                const tab = document.getElementById('desktopTabSearch');
                const input = document.getElementById('searchInput');
                if (desktopActiveTab !== 'search' || !panel || panel.inert || !input) return;
                const active = document.activeElement;
                if (active === tab || !panel.contains(active)) input.focus();
            });
        }

        function toggleSearchPanel(forceState) {
            // Now just opens the sidebar and switches to search tab
            const shouldOpen = forceState !== undefined ? forceState : true;
            if (shouldOpen) {
                togglePlaylistPanel(true);
                switchDesktopTab('search');
            } else {
                // no-op, closing is handled by togglePlaylistPanel
            }
        }

        function togglePlaylistPanel(forceState, restoreFocus) {
            const panel = document.getElementById('floatingPlaylistPanel');
            const trigger = document.getElementById('togglePlaylistBtn');
            const isOpen = !panel.classList.contains('translate-x-full');
            const shouldOpen = forceState !== undefined ? forceState : !isOpen;

            if (shouldOpen) {
                panel.classList.remove('translate-x-full');
                panel.inert = false;
                panel.setAttribute('aria-hidden', 'false');
                if (trigger) trigger.setAttribute('aria-expanded', 'true');
                const activeTab = document.getElementById(desktopActiveTab === 'search' ? 'desktopTabSearch' : 'desktopTabPlaylist');
                requestAnimationFrame(function () { if (activeTab) activeTab.focus(); });
                // 自动定位到正在播放的歌曲
                setTimeout(() => {
                    if (desktopActiveTab === 'playlist' && currentIndex !== -1) {
                        highlightCurrentSong();
                    }
                }, 300);
            } else {
                panel.classList.add('translate-x-full');
                panel.setAttribute('aria-hidden', 'true');
                panel.inert = true;
                if (trigger) trigger.setAttribute('aria-expanded', 'false');
                if (restoreFocus && trigger) requestAnimationFrame(function () { trigger.focus(); });
            }
        }

        // Desktop sidebar tab switching (mirroring mobile UX)
        let desktopActiveTab = 'playlist';
        function switchDesktopTab(tab, focusSearchInput) {
            desktopActiveTab = tab;
            const isPlaylist = tab === 'playlist';

            const tabPlaylist = document.getElementById('desktopTabPlaylist');
            const tabSearch = document.getElementById('desktopTabSearch');
            const contentPlaylist = document.getElementById('desktopContentPlaylist');
            const contentSearch = document.getElementById('desktopContentSearch');

            if (tabPlaylist) {
                tabPlaylist.classList.toggle('opacity-100', isPlaylist);
                tabPlaylist.classList.toggle('opacity-50', !isPlaylist);
                tabPlaylist.classList.toggle('border-primary-color', isPlaylist);
                tabPlaylist.classList.toggle('border-transparent', !isPlaylist);
            }
            if (tabSearch) {
                tabSearch.classList.toggle('opacity-100', !isPlaylist);
                tabSearch.classList.toggle('opacity-50', isPlaylist);
                tabSearch.classList.toggle('border-primary-color', !isPlaylist);
                tabSearch.classList.toggle('border-transparent', isPlaylist);
            }
            if (contentPlaylist) {
                contentPlaylist.classList.toggle('hidden', !isPlaylist);
                contentPlaylist.classList.toggle('flex', isPlaylist);
            }
            if (contentSearch) {
                contentSearch.classList.toggle('hidden', isPlaylist);
                contentSearch.classList.toggle('flex', !isPlaylist);
            }
            setAccessibleTabState(tabPlaylist, contentPlaylist, isPlaylist);
            setAccessibleTabState(tabSearch, contentSearch, !isPlaylist);

            // Auto-focus search input
            if (!isPlaylist && focusSearchInput !== false) {
                focusDesktopSearchInput();
            }
        }

        // ================= Copy Interaction Logic =================
        function setupCopyInteraction(elementId, getContentFn) {
            const el = document.getElementById(elementId);
            if (!el) return;

            const handleCopy = (e) => {
                e.preventDefault(); // Stop default context menu
                const text = getContentFn();
                if (!text) return;

                // Clipboard API Hack for iFrame
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    showToast(`已复制: ${text}`);
                } catch (err) {
                    console.error('Copy failed', err);
                    showToast('复制失败', true);
                }
                document.body.removeChild(textArea);
            };

            // Desktop Right Click
            el.addEventListener('contextmenu', handleCopy);

            // Mobile Long Press Logic
            let pressTimer;
            el.addEventListener('touchstart', (e) => {
                // e.preventDefault(); // Optional: might block scrolling if not careful
                pressTimer = setTimeout(() => {
                    handleCopy(e);
                }, 600); // 600ms long press
            }, { passive: false });

            el.addEventListener('touchend', () => clearTimeout(pressTimer));
            el.addEventListener('touchmove', () => clearTimeout(pressTimer));
        }

        let toastHideTimer = null;

        function showToast(msg, isError = false) {
            const toast = document.getElementById('copyToast');
            toast.querySelector('span').textContent = msg;
            toast.classList.remove('opacity-0', 'scale-90');
            toast.classList.add('opacity-100', 'scale-100');

            const icon = toast.querySelector('i');
            if (isError) {
                icon.className = "fas fa-times-circle text-red-500";
            } else {
                icon.className = "fas fa-check-circle text-primary-color";
            }

            if (toastHideTimer) clearTimeout(toastHideTimer);
            toastHideTimer = setTimeout(() => {
                toast.classList.add('opacity-0', 'scale-90');
                toast.classList.remove('opacity-100', 'scale-100');
                toastHideTimer = null;
            }, 2000);
        }

        let connectivityFeedbackBound = false;

        let serviceWorkerUpdateBound = false;
        let appUpdatePromptShown = false;
        let appUpdateReloadInFlight = false;

        function hideAppUpdatePrompt() {
            const banner = document.getElementById('appUpdateBanner');
            if (!banner) return;
            banner.classList.add('hidden');
            banner.classList.remove('flex');
            banner.setAttribute('aria-hidden', 'true');
        }

        function showAppUpdatePrompt() {
            if (appUpdatePromptShown) return;
            const banner = document.getElementById('appUpdateBanner');
            if (!banner) return;
            appUpdatePromptShown = true;
            banner.classList.remove('hidden');
            banner.classList.add('flex');
            banner.setAttribute('aria-hidden', 'false');
        }

        async function reloadForAppUpdate() {
            if (appUpdateReloadInFlight) return;
            appUpdateReloadInFlight = true;
            const reloadButton = document.getElementById('appUpdateReloadBtn');
            const reloadLabel = reloadButton ? reloadButton.querySelector('span') : null;
            if (reloadButton) reloadButton.disabled = true;
            if (reloadLabel) reloadLabel.textContent = '保存中';
            try {
                await Promise.resolve(flushScheduledQueueSave('sw_update_reload'));
                savePlaybackSession('sw_update_reload', true);
            } catch (error) {
                console.warn('[update] state flush failed before reload', error);
            }
            window.location.reload();
        }

        function setupServiceWorkerUpdates() {
            if (serviceWorkerUpdateBound || !('serviceWorker' in navigator)) return;
            serviceWorkerUpdateBound = true;
            let controllerSeen = Boolean(navigator.serviceWorker.controller);
            const reloadButton = document.getElementById('appUpdateReloadBtn');
            const dismissButton = document.getElementById('appUpdateDismissBtn');
            if (reloadButton) reloadButton.addEventListener('click', reloadForAppUpdate);
            if (dismissButton) dismissButton.addEventListener('click', hideAppUpdatePrompt);

            navigator.serviceWorker.addEventListener('controllerchange', function () {
                if (controllerSeen) showAppUpdatePrompt();
                controllerSeen = true;
            });

            navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(() => {
                console.log('📱 Service Worker 已注册');
            }).catch((error) => {
                console.warn('SW 注册失败:', error);
            });
        }

        function setupConnectivityFeedback() {
            if (connectivityFeedbackBound || typeof window === 'undefined' || typeof navigator === 'undefined') return;
            connectivityFeedbackBound = true;

            const notifyOffline = () => {
                showToast('已离线，已保存的歌单和最近播放仍可使用', true);
                refreshCloudAccountUI();
            };
            const notifyOnline = () => {
                showToast('网络已恢复');
                refreshCloudAccountUI();
                scheduleCloudSync('online', 0);
            };
            window.addEventListener('offline', notifyOffline);
            window.addEventListener('online', notifyOnline);
            if (navigator.onLine === false) setTimeout(notifyOffline, 300);
        }

        function getConfiguredCloud() {
            return normalizeCloudConfig(
                typeof window !== 'undefined' ? window.CPLAYER_CLOUD_CONFIG : null
            );
        }

        function readCloudLastSuccessfulAt(ownerId) {
            if (!ownerId) return 0;
            try {
                const record = JSON.parse(readLocalStorage(CLOUD_LAST_SUCCESS_KEY, 'null') || 'null');
                const timestamp = Number(record && record.at);
                return record && record.ownerId === ownerId && Number.isFinite(timestamp) && timestamp > 0
                    ? timestamp
                    : 0;
            } catch (error) {
                removeLocalStorage(CLOUD_LAST_SUCCESS_KEY);
                return 0;
            }
        }

        function normalizeCloudLastErrorRecord(record) {
            const ownerId = record && typeof record.ownerId === 'string' ? record.ownerId.trim() : '';
            const at = Number(record && record.at);
            const message = record && typeof record.message === 'string' ? record.message.trim().slice(0, 240) : '';
            if (!ownerId || !Number.isFinite(at) || at <= 0 || !message) return null;
            return { ownerId, at, message };
        }

        function readCloudLastError(ownerId) {
            if (!ownerId) return '';
            try {
                const record = normalizeCloudLastErrorRecord(
                    JSON.parse(readLocalStorage(CLOUD_LAST_ERROR_KEY, 'null') || 'null')
                );
                return record && record.ownerId === ownerId ? record.message : '';
            } catch (error) {
                removeLocalStorage(CLOUD_LAST_ERROR_KEY);
                return '';
            }
        }

        function rememberCloudSyncError(ownerId, message) {
            if (!ownerId || cloudUserId !== ownerId) return;
            const safeMessage = typeof message === 'string' ? message.trim().slice(0, 240) : '';
            if (!safeMessage) return;
            cloudLastErrorMessage = safeMessage;
            writeLocalStorage(CLOUD_LAST_ERROR_KEY, JSON.stringify({
                ownerId,
                at: Date.now(),
                message: safeMessage
            }));
        }

        function forgetCloudSyncError(ownerId) {
            if (!ownerId) return;
            try {
                const record = normalizeCloudLastErrorRecord(
                    JSON.parse(readLocalStorage(CLOUD_LAST_ERROR_KEY, 'null') || 'null')
                );
                if (record && record.ownerId === ownerId) removeLocalStorage(CLOUD_LAST_ERROR_KEY);
            } catch (error) {
                removeLocalStorage(CLOUD_LAST_ERROR_KEY);
            }
            if (cloudUserId === ownerId) cloudLastErrorMessage = '';
        }

        function formatTrashDeletedAt(timestamp) {
            const date = new Date(timestamp);
            return Number.isFinite(date.getTime())
                ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                : '删除时间未知';
        }

        async function refreshPlaylistTrash() {
            const box = document.getElementById('playlistTrashList');
            if (!box) return;
            try {
                await cleanupExpiredLocalTrash();
                const list = await readUserPlaylistRecords({ onlyTrash: true });
                const count = document.getElementById('libraryTrashCount');
                if (count) count.textContent = String(list.length);
                box.innerHTML = '';
                if (!list.length) {
                    box.innerHTML = '<div class="h-full min-h-40 flex items-center justify-center text-center opacity-50 text-sm">回收站是空的</div>';
                    return;
                }
                list.forEach(function (pl) {
                    const row = document.createElement('div');
                    row.className = 'music-library-row';
                    const cover = document.createElement('div');
                    cover.className = 'music-library-cover';
                    cover.innerHTML = '<i class="fas fa-trash-restore opacity-45" aria-hidden="true"></i>';
                    const info = document.createElement('div');
                    info.className = 'min-w-0';
                    const name = document.createElement('div');
                    name.className = 'font-medium truncate';
                    name.textContent = pl.name;
                    const remaining = getPlaylistTrashRemainingDays(pl.deletedAt, Date.now());
                    const detail = document.createElement('div');
                    detail.className = 'text-xs opacity-55 mt-1';
                    detail.textContent = pl.songs.length + ' 首 · ' + formatTrashDeletedAt(pl.deletedAt) +
                        ' · 剩余 ' + remaining + ' 天';
                    info.appendChild(name);
                    info.appendChild(detail);
                    const actions = document.createElement('div');
                    actions.className = 'music-library-row-actions flex items-center gap-2';
                    const restoreButton = makeLibraryActionButton(
                        '恢复歌单「' + pl.name + '」',
                        'fa-trash-restore',
                        'music-library-action-button',
                        '恢复'
                    );
                    restoreButton.onclick = async function () {
                        restoreButton.disabled = true;
                        try {
                            await restoreUserPlaylist(pl.id);
                            await Promise.all([refreshPlaylistTrash(), refreshMyPlaylists()]);
                            showToast('歌单「' + pl.name + '」已恢复');
                        } catch (error) {
                            console.error('[trash] restore failed', error);
                            showToast(error.message || '歌单恢复失败', true);
                        } finally {
                            restoreButton.disabled = false;
                        }
                    };
                    const purgeButton = makeLibraryActionButton(
                        '永久删除歌单「' + pl.name + '」',
                        'fa-trash-alt',
                        'music-library-action-button',
                        '永久删除'
                    );
                    purgeButton.style.color = '#ffb5b5';
                    purgeButton.onclick = async function () {
                        if (!confirm('永久删除歌单「' + pl.name + '」？\n名称、歌曲和历史版本都会被清除，且无法恢复。')) return;
                        purgeButton.disabled = true;
                        try {
                            await purgeUserPlaylist(pl.id);
                            await refreshPlaylistTrash();
                            showToast(navigator.onLine === false
                                ? '已从本机永久删除，联网后同步'
                                : '歌单已永久删除');
                        } catch (error) {
                            console.error('[trash] purge failed', error);
                            showToast(error.message || '永久删除失败', true);
                        } finally {
                            purgeButton.disabled = false;
                        }
                    };
                    actions.appendChild(restoreButton);
                    actions.appendChild(purgeButton);
                    row.appendChild(cover);
                    row.appendChild(info);
                    row.appendChild(actions);
                    box.appendChild(row);
                });
            } catch (error) {
                console.error('[trash] render failed', error);
                box.innerHTML = '<div class="p-4 text-center text-red-300 text-sm">回收站加载失败，请重试</div>';
            }
        }

        function rememberCloudSyncSuccess(ownerId) {
            if (!ownerId || cloudUserId !== ownerId) return;
            const previous = cloudLastSuccessfulAt;
            cloudLastSuccessfulAt = Date.now();
            writeLocalStorage(CLOUD_LAST_SUCCESS_KEY, JSON.stringify({
                ownerId,
                at: cloudLastSuccessfulAt
            }));
            if (cloudLastSuccessfulAt !== previous) {
                invalidateCloudHealthSnapshot('最近成功同步记录已更新');
            }
        }

        function forgetCloudSyncSuccess(ownerId) {
            if (!ownerId) return;
            try {
                const record = JSON.parse(readLocalStorage(CLOUD_LAST_SUCCESS_KEY, 'null') || 'null');
                if (record && record.ownerId === ownerId) removeLocalStorage(CLOUD_LAST_SUCCESS_KEY);
            } catch (error) {
                removeLocalStorage(CLOUD_LAST_SUCCESS_KEY);
            }
            if (cloudUserId === ownerId) cloudLastSuccessfulAt = 0;
        }

        const CLOUD_BADGE_TONE_CLASSES = [
            'border-slate-300/20', 'bg-slate-400/20', 'text-slate-200',
            'border-sky-200/30', 'bg-sky-300/15', 'text-sky-100',
            'border-emerald-200/30', 'bg-emerald-300/15', 'text-emerald-100',
            'border-amber-200/30', 'bg-amber-300/15', 'text-amber-100',
            'border-red-200/30', 'bg-red-300/15', 'text-red-100'
        ];
        const CLOUD_BADGE_TONES = Object.freeze({
            disabled: ['border-slate-300/20', 'bg-slate-400/20', 'text-slate-200'],
            'signed-out': ['border-slate-300/20', 'bg-slate-400/20', 'text-slate-200'],
            syncing: ['border-sky-200/30', 'bg-sky-300/15', 'text-sky-100'],
            synced: ['border-emerald-200/30', 'bg-emerald-300/15', 'text-emerald-100'],
            pending: ['border-amber-200/30', 'bg-amber-300/15', 'text-amber-100'],
            conflict: ['border-amber-200/30', 'bg-amber-300/15', 'text-amber-100'],
            error: ['border-red-200/30', 'bg-red-300/15', 'text-red-100']
        });
        const CLOUD_DOT_TONE_CLASSES = [
            'bg-slate-400', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400', 'bg-red-400'
        ];
        const CLOUD_DOT_TONES = Object.freeze({
            disabled: 'bg-slate-400',
            'signed-out': 'bg-slate-400',
            syncing: 'bg-sky-400',
            synced: 'bg-emerald-400',
            pending: 'bg-amber-400',
            conflict: 'bg-amber-400',
            error: 'bg-red-400'
        });

        function applyCloudStatusProjection(projection) {
            document.documentElement.dataset.cplayerCloudPending = String(projection.pendingCount);
            document.documentElement.dataset.cplayerCloudConflicts = String(projection.conflictCount);
            document.documentElement.dataset.cplayerCloudLastSuccess = cloudLastSuccessfulAt
                ? String(cloudLastSuccessfulAt)
                : '';

            ['settingsBtn', 'mobileSettingsBtn'].forEach(function (id) {
                const button = document.getElementById(id);
                if (!button) return;
                button.title = projection.entryLabel;
                button.setAttribute('aria-label', projection.entryLabel);
            });
            document.querySelectorAll('[data-cloud-status-indicator]').forEach(function (dot) {
                dot.classList.remove(...CLOUD_DOT_TONE_CLASSES);
                dot.classList.add(CLOUD_DOT_TONES[projection.visualState] || CLOUD_DOT_TONES.disabled);
                dot.dataset.cloudState = projection.visualState;
            });

            const badge = document.getElementById('cloudStatusBadge');
            if (badge) {
                badge.textContent = projection.label;
                badge.classList.remove(...CLOUD_BADGE_TONE_CLASSES);
                const tone = CLOUD_BADGE_TONES[projection.visualState] || CLOUD_BADGE_TONES.disabled;
                badge.classList.add(...tone);
                badge.dataset.cloudState = projection.visualState;
            }
            const pending = document.getElementById('cloudPendingCount');
            const conflicts = document.getElementById('cloudConflictCount');
            const lastSuccess = document.getElementById('cloudLastSuccessfulAt');
            if (pending) pending.textContent = String(projection.pendingCount);
            if (conflicts) conflicts.textContent = String(projection.conflictCount);
            if (lastSuccess) lastSuccess.textContent = projection.lastSuccessfulText;

            const lastError = document.getElementById('cloudLastError');
            setCloudSectionVisible(lastError, !!cloudLastErrorMessage);
            if (lastError) lastError.textContent = cloudLastErrorMessage
                ? '最近错误：' + cloudLastErrorMessage
                : '';
            const syncLabel = document.getElementById('cloudAccountSyncBtnLabel');
            if (syncLabel) syncLabel.textContent = projection.retrySuggested ? '重试同步' : '立即同步';
        }

        function setCloudState(nextState, message, error) {
            const stateChanged = cloudState !== nextState ||
                (message && cloudStateMessage !== message);
            cloudState = nextState;
            if (message) cloudStateMessage = message;
            if (nextState === 'error') {
                cloudLastErrorMessage = message || '云同步操作失败';
                rememberCloudSyncError(cloudUserId, cloudLastErrorMessage);
            } else if (nextState === 'synced') {
                if (cloudUserId) forgetCloudSyncError(cloudUserId);
                else cloudLastErrorMessage = '';
            } else if (nextState === 'signed-out' || nextState === 'disabled') {
                cloudLastErrorMessage = '';
            }
            document.documentElement.dataset.cplayerCloudState = nextState;
            if (error) console.warn('[cloud]', message || nextState, error);
            if (stateChanged) invalidateCloudHealthSnapshot('云同步状态已变化');
            refreshCloudAccountUI();
        }

        function cloudErrorMessage(error, fallback) {
            const text = [
                error && error.message,
                error && error.details,
                error && error.hint,
                error && error.code
            ].filter(Boolean).join(' ');
            if (isCloudConflictError(error)) return '云端歌单刚刚被其他设备修改，请选择保留哪一份';
            if (error && error.name === 'CloudOwnerCollisionError') {
                return '本机已有其他账号的同 ID 歌单，未覆盖本地数据；请退出其他账号或删除冲突歌单后重试';
            }
            if (/invalid login credentials|invalid password|invalid email/i.test(text)) return '邮箱或密码不正确';
            if (/user already registered|already been registered/i.test(text)) return '这个邮箱已经注册，请直接登录';
            if (/email not confirmed|confirm your email/i.test(text)) return '请先完成邮箱验证，再登录';
            if (/playlist_limit_reached|歌单数量达到上限/i.test(text)) return '云端歌单已达到 500 个上限，请先删除不需要的歌单';
            if (/rate limit|too many requests/i.test(text)) return '操作太频繁，请稍后再试';
            if (/storage|localstorage|持久|存储/i.test(text)) return '浏览器存储不可用，登录状态无法可靠保存';
            if (/fetch|network|timeout|offline|failed to/i.test(text)) return '云同步暂时无法连接，已保留本机数据';
            return fallback || '云同步操作失败，本机数据未受影响';
        }

        function setCloudSectionVisible(element, visible) {
            if (!element) return;
            element.classList.toggle('hidden', !visible);
            element.inert = !visible;
        }

        function renderCloudPendingUI() {
            const section = document.getElementById('cloudPendingQueue');
            const list = document.getElementById('cloudPendingList');
            const retryAll = document.getElementById('cloudRetryAllBtn');
            if (!section || !list || !retryAll) return;

            const configured = Boolean(getConfiguredCloud());
            const signedIn = Boolean(configured && cloudService && cloudSession && cloudUserId);
            const hasPending = cloudPendingCount > 0;
            setCloudSectionVisible(section, hasPending);
            list.innerHTML = '';
            retryAll.disabled = cloudAccountBusy || !signedIn || navigator.onLine === false || !cloudPendingItems.length;
            retryAll.title = signedIn
                ? (navigator.onLine === false ? '联网后才能重试全部待同步项目' : '重试全部待同步项目')
                : '登录对应账号后才能重试';

            if (!hasPending) return;
            if (!signedIn) {
                const message = document.createElement('div');
                message.className = 'rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-[11px] opacity-70';
                message.textContent = '登录对应账号后查看具体待同步歌单并继续同步。';
                list.appendChild(message);
                return;
            }
            if (!cloudPendingItems.length) {
                const loading = document.createElement('div');
                loading.className = 'rounded-xl border border-white/10 bg-black/10 px-3 py-2 text-[11px] opacity-70';
                loading.textContent = '正在读取待同步项目…';
                list.appendChild(loading);
                return;
            }

            cloudPendingItems.forEach(function (item) {
                const row = document.createElement('div');
                row.className = 'flex items-center gap-2 rounded-xl border border-white/10 bg-black/10 px-3 py-2';
                row.dataset.cloudOutboxId = item.id;

                const info = document.createElement('div');
                info.className = 'min-w-0 flex-1';
                const name = document.createElement('div');
                name.className = 'truncate text-xs font-semibold';
                name.textContent = item.name;
                const detail = document.createElement('div');
                detail.className = 'mt-1 text-[11px] opacity-60';
                const songText = item.songCount == null ? '' : ' · ' + item.songCount + ' 首';
                detail.textContent = cloudPendingOperationLabel(item.operation) + songText +
                    ' · ' + formatCloudPendingUpdatedAt(item.updatedAt);
                info.appendChild(name);
                info.appendChild(detail);

                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'min-h-[40px] shrink-0 rounded-xl bg-white/10 px-3 text-[11px] font-semibold';
                retry.textContent = '重试';
                retry.setAttribute('aria-label', '重试歌单「' + item.name + '」');
                retry.title = navigator.onLine === false ? '联网后才能重试' : '重试歌单「' + item.name + '」';
                retry.disabled = cloudAccountBusy || navigator.onLine === false;
                retry.addEventListener('click', function () { void retryCloudOutboxItem(item.id); });
                row.appendChild(info);
                row.appendChild(retry);
                list.appendChild(row);
            });
        }

        const CLOUD_DIFF_PREVIEW_LIMIT = 6;

        function makeCloudDiffSongText(song) {
            const name = song && song.name ? song.name : '未知歌曲';
            const artist = song && song.artist ? song.artist : '未知艺术家';
            return name + ' · ' + artist;
        }

        function appendCloudDiffSection(container, title, items, emptyText, renderItem) {
            const section = document.createElement('div');
            section.className = 'rounded-xl border border-white/10 bg-black/10 p-2.5';
            const heading = document.createElement('div');
            heading.className = 'text-[11px] font-semibold opacity-70';
            heading.textContent = title;
            section.appendChild(heading);
            const list = document.createElement('div');
            list.className = 'mt-1 space-y-1';
            const values = Array.isArray(items) ? items : [];
            if (!values.length) {
                const empty = document.createElement('div');
                empty.className = 'text-[11px] opacity-45';
                empty.textContent = emptyText;
                list.appendChild(empty);
            } else {
                values.slice(0, CLOUD_DIFF_PREVIEW_LIMIT).forEach(function (item) {
                    const row = document.createElement('div');
                    row.className = 'min-w-0 text-[11px] leading-5';
                    row.textContent = renderItem(item);
                    list.appendChild(row);
                });
                if (values.length > CLOUD_DIFF_PREVIEW_LIMIT) {
                    const more = document.createElement('div');
                    more.className = 'text-[11px] opacity-45';
                    more.textContent = '还有 ' + (values.length - CLOUD_DIFF_PREVIEW_LIMIT) + ' 项未展开';
                    list.appendChild(more);
                }
            }
            section.appendChild(list);
            container.appendChild(section);
        }

        function renderCloudConflictDiff(conflict) {
            const box = document.getElementById('cloudAccountConflictDiff');
            if (!box) return;
            box.innerHTML = '';
            if (!conflict) return;
            const summary = document.createElement('div');
            summary.className = 'text-[11px] opacity-75';
            try {
                const diff = diffPlaylistContent(conflict.local, conflict.remote);
                const parts = [];
                if (diff.nameChanged) parts.push('名称不同');
                if (diff.localOnly.length) parts.push('本机多 ' + diff.localOnly.length + ' 首');
                if (diff.remoteOnly.length) parts.push('云端多 ' + diff.remoteOnly.length + ' 首');
                if (diff.metadataChanged.length) parts.push(diff.metadataChanged.length + ' 首信息不同');
                if (diff.orderChanged) parts.push('顺序不同');
                summary.textContent = parts.length
                    ? '差异：' + parts.join(' · ')
                    : '两边歌单内容相同，请确认要保留哪一份';
                box.appendChild(summary);

                const counts = document.createElement('div');
                counts.className = 'mt-2 grid grid-cols-2 gap-2 text-[11px]';
                const localCount = document.createElement('div');
                localCount.className = 'rounded-lg bg-white/5 px-2.5 py-2';
                localCount.textContent = '本机：' + (diff.localName || '未命名歌单') + ' · ' + diff.localSongCount + ' 首';
                const remoteCount = document.createElement('div');
                remoteCount.className = 'rounded-lg bg-white/5 px-2.5 py-2';
                remoteCount.textContent = '云端：' + (diff.remoteName || '未命名歌单') + ' · ' + diff.remoteSongCount + ' 首';
                counts.appendChild(localCount);
                counts.appendChild(remoteCount);
                box.appendChild(counts);

                const sections = document.createElement('div');
                sections.className = 'mt-2 grid gap-2';
                appendCloudDiffSection(sections, '仅本机有', diff.localOnly, '没有本机独有歌曲', makeCloudDiffSongText);
                appendCloudDiffSection(sections, '仅云端有', diff.remoteOnly, '没有云端独有歌曲', makeCloudDiffSongText);
                appendCloudDiffSection(sections, '歌曲信息变化', diff.metadataChanged, '没有同歌不同信息', function (item) {
                    return '本机：' + makeCloudDiffSongText(item.local) + '；云端：' + makeCloudDiffSongText(item.remote);
                });
                const orderItems = diff.orderChanged ? [
                    { label: '本机顺序', songs: diff.localOrder },
                    { label: '云端顺序', songs: diff.remoteOrder }
                ] : [];
                appendCloudDiffSection(sections, '共同歌曲顺序', orderItems, '共同歌曲顺序一致', function (item) {
                    return item.label + '：' + item.songs.slice(0, CLOUD_DIFF_PREVIEW_LIMIT)
                        .map(makeCloudDiffSongText).join(' → ') +
                        (item.songs.length > CLOUD_DIFF_PREVIEW_LIMIT ? ' …' : '');
                });
                box.appendChild(sections);
            } catch (error) {
                summary.textContent = '差异预览暂时不可用，但你仍可以选择保留本机或云端版本';
                box.appendChild(summary);
                console.warn('[cloud] conflict diff preview failed', error);
            }
        }

        function refreshCloudConflictUI() {
            const panel = document.getElementById('cloudAccountConflict');
            const name = document.getElementById('cloudAccountConflictName');
            const position = document.getElementById('cloudAccountConflictPosition');
            const conflict = cloudConflicts.values().next().value || null;
            setCloudSectionVisible(panel, !!conflict);
            if (name) name.textContent = conflict
                ? (conflict.local && conflict.local.name) || (conflict.remote && conflict.remote.name) || '未命名歌单'
                : '';
            if (position) position.textContent = conflict ? '1 / ' + cloudConflicts.size : '0 / 0';
            renderCloudConflictDiff(conflict);
        }

        function refreshCloudAccountUI() {
            const config = getConfiguredCloud();
            const hasConfig = !!config;
            const configured = hasConfig && !!cloudService;
            const signedIn = configured && !!cloudSession && !!cloudUserId;
            const projection = projectCloudSyncStatus({
                state: cloudState,
                signedIn,
                pendingCount: cloudPendingCount,
                conflictCount: cloudConflicts.size,
                lastSuccessfulAt: cloudLastSuccessfulAt
            });
            applyCloudStatusProjection(projection);

            const card = document.getElementById('cloudAccountCard');
            if (!card) return;
            const signedOut = document.getElementById('cloudAccountSignedOut');
            const signedInPanel = document.getElementById('cloudAccountSignedIn');
            const recovery = document.getElementById('cloudAccountRecovery');
            const status = document.getElementById('cloudAccountStatus');
            const email = document.getElementById('cloudAccountUserEmail');
            const emailInput = document.getElementById('cloudAccountEmail');
            const allButtons = card.querySelectorAll('button:not(#cloudHealthCheckBtn):not(#cloudHealthCheckExportBtn)');

            setCloudSectionVisible(signedOut, configured && !signedIn && !cloudRecoveryMode);
            setCloudSectionVisible(signedInPanel, signedIn && !cloudRecoveryMode);
            setCloudSectionVisible(recovery, configured && cloudRecoveryMode);
            if (email) email.textContent = cloudSession && cloudSession.user ? (cloudSession.user.email || '') : '';
            if (status) {
                let statusText;
                if (!hasConfig) statusText = '云同步尚未配置，播放器仍可本地使用';
                else if (cloudRecoveryMode) statusText = '请设置新的登录密码';
                else statusText = cloudStateMessage;
                if (!signedIn && projection.pendingCount > 0) {
                    statusText += '；本机有 ' + projection.pendingCount + ' 项待同步，登录对应账号后继续';
                } else if (signedIn && projection.pendingCount > 0 &&
                    cloudState !== 'conflict' && cloudState !== 'error') {
                    statusText += '（' + projection.pendingCount + ' 项）';
                }
                status.textContent = statusText;
            }
            if (emailInput && signedIn && cloudSession.user && !emailInput.value) {
                emailInput.value = cloudSession.user.email || '';
            }
            allButtons.forEach(function (button) {
                button.disabled = cloudAccountBusy || !configured;
            });
            const conflict = cloudConflicts.size > 0;
            const localButton = document.getElementById('cloudAccountUseLocalBtn');
            const remoteButton = document.getElementById('cloudAccountUseCloudBtn');
            if (localButton) localButton.disabled = cloudAccountBusy || !conflict;
            if (remoteButton) remoteButton.disabled = cloudAccountBusy || !conflict;
            refreshCloudConflictUI();
            renderCloudPendingUI();
        }

        let cloudHealthCheckBusy = false;
        let cloudHealthSnapshot = null;
        let cloudHealthRevision = 0;

        function isCloudHealthSnapshotFresh() {
            return !!cloudHealthSnapshot &&
                cloudHealthSnapshot.revision === cloudHealthRevision &&
                cloudHealthSnapshot.ownerId === (cloudUserId || '');
        }

        function renderCloudHealthFreshness() {
            const notice = document.getElementById('cloudHealthCheckFreshness');
            const exportButton = document.getElementById('cloudHealthCheckExportBtn');
            const fresh = isCloudHealthSnapshotFresh();
            if (notice) {
                notice.classList.toggle('hidden', !cloudHealthSnapshot || fresh);
                notice.textContent = fresh
                    ? ''
                    : '本机状态已变化，当前报告已过期；请重新检查后再导出报告。';
            }
            if (exportButton) {
                exportButton.classList.toggle('hidden', !cloudHealthSnapshot);
                exportButton.disabled = !fresh || cloudHealthCheckBusy;
            }
        }

        function invalidateCloudHealthSnapshot(reason) {
            cloudHealthRevision += 1;
            if (!cloudHealthSnapshot) return;
            renderCloudHealthFreshness(reason);
        }

        function cloudHealthStatusLabel(status) {
            return status === 'pass' ? '通过' : status === 'warn' ? '需留意' : '受阻';
        }

        function cloudHealthStatusClasses(status) {
            if (status === 'pass') return ['border-emerald-200/25', 'bg-emerald-300/10', 'text-emerald-100'];
            if (status === 'warn') return ['border-amber-200/25', 'bg-amber-300/10', 'text-amber-100'];
            return ['border-red-200/25', 'bg-red-300/10', 'text-red-100'];
        }

        async function inspectIndexedDbHealth() {
            const requiredStores = ['playlists', 'lyrics', 'images', CLOUD_OUTBOX_STORE, PLAYLIST_HISTORY_STORE];
            try {
                if (!db) await initDatabase();
                if (!db) throw new Error('IndexedDB connection unavailable');
                const stores = Array.from(db.objectStoreNames);
                const missingStores = requiredStores.filter(function (name) { return stores.indexOf(name) === -1; });
                const outbox = await readCloudOutbox(cloudUserId || '');
                if (missingStores.length) {
                    return {
                        id: 'indexeddb',
                        status: 'fail',
                        detail: '本机数据库可读取，但缺少关键数据表：' + missingStores.join('、'),
                        recommendation: '请刷新页面；如果仍然出现，请关闭其他播放器页面后重试。',
                        dbVersion: Number(db.version) || 0,
                        stores: stores,
                        pendingCount: outbox.length
                    };
                }
                const state = storageState === 'ready' ? 'pass' : storageState === 'degraded' ? 'warn' : 'fail';
                return {
                    id: 'indexeddb',
                    status: state,
                    detail: '本机数据库可读取，版本 v' + (Number(db.version) || 0) + '，待同步 ' + outbox.length + ' 项。',
                    recommendation: state === 'pass' ? '无需处理。' : '请刷新页面；暂时不要清理浏览器站点数据。',
                    dbVersion: Number(db.version) || 0,
                    stores: stores,
                    pendingCount: outbox.length
                };
            } catch (error) {
                return {
                    id: 'indexeddb',
                    status: 'fail',
                    detail: '本机数据库暂时无法读取。',
                    recommendation: '请刷新页面并关闭其他播放器页面；在处理前不要清理站点数据。',
                    dbVersion: 0,
                    stores: [],
                    pendingCount: 0
                };
            }
        }

        async function inspectServiceWorkerHealth() {
            const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
            const cacheSupported = typeof window !== 'undefined' && 'caches' in window;
            if (!supported) {
                return {
                    id: 'service-worker',
                    status: 'warn',
                    detail: '当前浏览器不支持 Service Worker，离线页面缓存不可用。',
                    recommendation: '播放器仍可在线使用；如需离线打开，请换用支持 PWA 的浏览器。',
                    supported: false,
                    controller: false,
                    cacheSupported: cacheSupported,
                    appCacheCount: 0
                };
            }
            let appCacheCount = 0;
            try {
                if (cacheSupported) {
                    const keys = await caches.keys();
                    appCacheCount = keys.filter(function (key) { return key.indexOf('cplayer5-') === 0; }).length;
                }
            } catch (error) {
                return {
                    id: 'service-worker',
                    status: 'warn',
                    detail: 'Service Worker 已支持，但无法读取缓存状态。',
                    recommendation: '联网后刷新一次页面；不要因此删除本机歌单。',
                    supported: true,
                    controller: Boolean(navigator.serviceWorker.controller),
                    cacheSupported: cacheSupported,
                    appCacheCount: 0
                };
            }
            const controller = Boolean(navigator.serviceWorker.controller);
            const status = controller && cacheSupported && appCacheCount > 0 ? 'pass' : 'warn';
            return {
                id: 'service-worker',
                status: status,
                detail: controller
                    ? (appCacheCount > 0 ? 'Service Worker 已接管，检测到 ' + appCacheCount + ' 个应用缓存。' : 'Service Worker 已接管，但暂未检测到应用缓存。')
                    : 'Service Worker 尚未接管当前页面。',
                recommendation: status === 'pass' ? '无需处理。' : '联网后刷新一次页面，等待应用完成首次缓存。',
                supported: true,
                controller: controller,
                cacheSupported: cacheSupported,
                appCacheCount: appCacheCount
            };
        }

        function inspectCloudHealth(pendingCountOverride) {
            const suppliedPendingCount = Number(pendingCountOverride);
            const pendingCount = Number.isSafeInteger(suppliedPendingCount) && suppliedPendingCount >= 0
                ? suppliedPendingCount
                : cloudPendingCount;
            const configured = Boolean(getConfiguredCloud());
            const signedIn = Boolean(cloudSession && cloudUserId);
            const recentError = signedIn
                ? (cloudLastErrorMessage || readCloudLastError(cloudUserId))
                : '';
            if (!configured) {
                return {
                    id: 'cloud',
                    status: pendingCount > 0 ? 'warn' : 'pass',
                    detail: pendingCount > 0
                        ? '云同步未配置；本机仍有 ' + pendingCount + ' 项待同步改动，播放器保持本机优先。'
                        : '云同步未配置；播放器保持本机优先且无需登录。',
                    recommendation: pendingCount > 0
                        ? '如需保留这些改动并跨设备同步，请配置并登录对应账号；在此之前不要清理站点数据。'
                        : '如需跨设备歌单，再在设置中配置云同步并登录。',
                    configured: false,
                    signedIn: false,
                    state: 'disabled',
                    pendingCount: pendingCount,
                    conflictCount: cloudConflicts.size,
                    hasRecentSuccess: false,
                    lastError: ''
                };
            }
            if (!signedIn) {
                return {
                    id: 'cloud',
                    status: pendingCount > 0 ? 'warn' : 'pass',
                    detail: pendingCount > 0
                        ? '尚未登录，本机有 ' + pendingCount + ' 项等待对应账号同步。'
                        : '云同步已配置但当前未登录；本机歌单仍可完整使用。',
                    recommendation: pendingCount > 0 ? '登录对应账号后再同步，避免把本机改动留在待同步队列。' : '如需跨设备同步，请登录对应账号。',
                    configured: true,
                    signedIn: false,
                    state: cloudState,
                    pendingCount: pendingCount,
                    conflictCount: cloudConflicts.size,
                    hasRecentSuccess: false,
                    lastError: ''
                };
            }
            const hasConflict = cloudConflicts.size > 0 || cloudState === 'conflict';
            const hasError = cloudState === 'error' || !!recentError;
            const hasPending = pendingCount > 0 || cloudState === 'pending' || cloudState === 'syncing';
            const status = hasConflict || hasError || hasPending ? 'warn' : 'pass';
            const recentSuccessDetail = cloudLastSuccessfulAt > 0 ? '最近有成功同步记录。' : '尚无成功同步记录。';
            return {
                id: 'cloud',
                status: status,
                detail: hasConflict
                    ? '已登录，但有 ' + cloudConflicts.size + ' 个冲突需要选择保留版本。'
                    : hasError
                        ? '已登录，但最近一次同步报错：' + recentError + '本机数据仍保留。' + recentSuccessDetail
                        : hasPending
                            ? '已登录，当前有 ' + pendingCount + ' 项等待同步。' + recentSuccessDetail
                            : '已登录，云同步状态正常。' + recentSuccessDetail,
                recommendation: hasConflict ? '打开冲突差异预览，明确选择本机或云端版本。' : hasError ? '联网后点击“重试同步”；不要手动覆盖歌单。' : hasPending ? '保持联网，或点击“立即同步”。' : '无需处理。',
                configured: true,
                signedIn: true,
                state: cloudState,
                pendingCount: pendingCount,
                conflictCount: cloudConflicts.size,
                hasRecentSuccess: cloudLastSuccessfulAt > 0,
                lastError: recentError
            };
        }

        function inspectRecoveryHealth() {
            const exportReady = Boolean(document.getElementById('recoveryPackageExportBtn') && typeof createRecoveryPackage === 'function');
            const importPreviewReady = Boolean(document.getElementById('recoveryPackageImportBtn') && document.getElementById('recoveryImportPreviewModal') && typeof openRecoveryImportPreview === 'function');
            const status = exportReady && importPreviewReady ? 'pass' : 'fail';
            return {
                id: 'recovery',
                status: status,
                detail: status === 'pass' ? '恢复包导出和导入预览入口可用。' : '恢复能力入口不完整。',
                recommendation: status === 'pass' ? '定期导出恢复包，并把文件保存在安全位置。' : '请刷新页面；如果仍缺失，请重新部署应用。',
                exportReady: exportReady,
                importPreviewReady: importPreviewReady
            };
        }

        function renderCloudHealthSnapshot(snapshot) {
            const status = document.getElementById('cloudHealthCheckStatus');
            const list = document.getElementById('cloudHealthCheckList');
            if (!status || !list) return;
            const counts = snapshot.items.reduce(function (result, item) {
                result[item.status] += 1;
                return result;
            }, { pass: 0, warn: 0, fail: 0 });
            status.textContent = '检查完成：' + counts.pass + ' 项通过，' + counts.warn + ' 项需留意，' + counts.fail + ' 项受阻。';
            list.innerHTML = '';
            snapshot.items.forEach(function (item) {
                const row = document.createElement('div');
                row.className = 'rounded-xl border px-3 py-2 text-[11px]';
                row.classList.add(...cloudHealthStatusClasses(item.status));
                const heading = document.createElement('div');
                heading.className = 'flex items-center justify-between gap-2 font-semibold';
                const title = document.createElement('span');
                title.textContent = item.title;
                const badge = document.createElement('span');
                badge.className = 'shrink-0';
                badge.textContent = cloudHealthStatusLabel(item.status);
                heading.appendChild(title);
                heading.appendChild(badge);
                const detail = document.createElement('div');
                detail.className = 'mt-1';
                detail.textContent = item.detail;
                const recommendation = document.createElement('div');
                recommendation.className = 'mt-1 opacity-75';
                recommendation.textContent = '建议：' + item.recommendation;
                row.appendChild(heading);
                row.appendChild(detail);
                row.appendChild(recommendation);
                list.appendChild(row);
            });
            renderCloudHealthFreshness();
        }

        function sanitizeCloudHealthReport(snapshot) {
            return {
                format: 'cplayer-sync-health-report',
                version: 1,
                generatedAt: snapshot.generatedAt,
                stale: !isCloudHealthSnapshotFresh(),
                items: snapshot.items.map(function (item) {
                    return {
                        id: item.id,
                        title: item.title,
                        status: item.status,
                        detail: item.detail,
                        recommendation: item.recommendation,
                        ...(item.lastError ? { lastError: item.lastError } : {})
                    };
                }),
                summary: snapshot.summary
            };
        }

        function exportCloudHealthReport() {
            if (!isCloudHealthSnapshotFresh()) {
                renderCloudHealthFreshness();
                showToast('健康检查结果已过期，请重新检查', true);
                return;
            }
            const report = sanitizeCloudHealthReport(cloudHealthSnapshot);
            const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'cplayer-sync-health-' + new Date(report.generatedAt).toISOString().slice(0, 10) + '.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        }

        async function runCloudHealthCheck() {
            if (cloudHealthCheckBusy) return;
            const startedRevision = cloudHealthRevision;
            const startedOwnerId = cloudUserId || '';
            const button = document.getElementById('cloudHealthCheckBtn');
            const exportButton = document.getElementById('cloudHealthCheckExportBtn');
            const status = document.getElementById('cloudHealthCheckStatus');
            cloudHealthCheckBusy = true;
            if (button) button.disabled = true;
            if (exportButton) exportButton.disabled = true;
            if (status) status.textContent = '正在读取本机状态，请稍候…';
            try {
                const indexedDb = await inspectIndexedDbHealth();
                const serviceWorker = await inspectServiceWorkerHealth();
                const cloud = inspectCloudHealth(indexedDb.pendingCount);
                const recovery = inspectRecoveryHealth();
                const items = [
                    { ...indexedDb, title: '本机数据库与待同步队列' },
                    { ...cloud, title: '账号与云同步状态' },
                    { ...serviceWorker, title: 'Service Worker 与离线缓存' },
                    { ...recovery, title: '自助恢复入口' }
                ];
                const summary = items.reduce(function (result, item) {
                    result[item.status] += 1;
                    return result;
                }, { pass: 0, warn: 0, fail: 0 });
                cloudHealthSnapshot = {
                    generatedAt: Date.now(),
                    revision: startedRevision,
                    ownerId: startedOwnerId,
                    items: items,
                    summary: summary
                };
                renderCloudHealthSnapshot(cloudHealthSnapshot);
            } catch (error) {
                cloudHealthSnapshot = null;
                if (status) status.textContent = '健康检查失败，但没有修改本机数据。请刷新页面后重试。';
                console.warn('[cloud-health] read-only check failed', error);
            } finally {
                cloudHealthCheckBusy = false;
                if (button) button.disabled = false;
                renderCloudHealthFreshness();
            }
        }

        window.runCloudHealthCheck = runCloudHealthCheck;
        window.getCloudHealthReport = function () {
            return cloudHealthSnapshot ? sanitizeCloudHealthReport(cloudHealthSnapshot) : null;
        };

        function setCloudAccountBusy(value) {
            cloudAccountBusy = !!value;
            refreshCloudAccountUI();
        }

        function getCloudEmailInput() {
            const input = document.getElementById('cloudAccountEmail');
            const email = input ? input.value.trim() : '';
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                throw new Error('请输入有效的邮箱地址');
            }
            return email;
        }

        function getCloudPasswordInput(id) {
            const input = document.getElementById(id || 'cloudAccountPassword');
            const password = input ? input.value : '';
            if (password.length < 8) throw new Error('密码至少需要 8 个字符');
            return password;
        }

        function clearCloudPasswordInputs() {
            ['cloudAccountPassword', 'cloudAccountNewPassword'].forEach(function (id) {
                const input = document.getElementById(id);
                if (input) input.value = '';
            });
        }

        function cloudRedirectUrl() {
            return new URL('./index.html', window.location.href).href;
        }

        function makeCloudStorageAdapter() {
            return {
                getItem: function (key) {
                    return Promise.resolve(readLocalStorage(key, null));
                },
                setItem: function (key, value) {
                    if (!writeLocalStorage(key, value)) {
                        return Promise.reject(new Error('登录会话无法保存到浏览器存储'));
                    }
                    return Promise.resolve();
                },
                removeItem: function (key) {
                    if (!removeLocalStorage(key)) {
                        return Promise.reject(new Error('登录会话无法从浏览器存储中移除'));
                    }
                    return Promise.resolve();
                }
            };
        }

        function handleCloudSession(event, session) {
            const previousUserId = cloudUserId;
            cloudSession = session || null;
            cloudUserId = cloudSession && cloudSession.user ? String(cloudSession.user.id || '') : '';
            const accountChanged = previousUserId !== cloudUserId;
            if (accountChanged) {
                cloudConflicts.clear();
                invalidateCloudHealthSnapshot('云同步账号已变化');
            }
            cloudLastSuccessfulAt = cloudUserId ? readCloudLastSuccessfulAt(cloudUserId) : 0;
            cloudLastErrorMessage = cloudUserId ? readCloudLastError(cloudUserId) : '';
            if (accountChanged) setCloudPendingCount(0);
            if (event === 'PASSWORD_RECOVERY') {
                cloudRecoveryMode = true;
                setCloudState('signed-out', '请设置新的登录密码');
                void refreshCloudPendingCount(cloudUserId);
            } else if (cloudUserId) {
                cloudRecoveryMode = false;
                setCloudState('pending', '已登录，正在检查歌单同步状态');
                void refreshCloudPendingCount(cloudUserId);
                if (accountChanged && typeof refreshMyPlaylists === 'function') {
                    void refreshMyPlaylists();
                }
                scheduleCloudSync('auth_session', 0);
            } else {
                cloudRecoveryMode = false;
                cloudConflicts.clear();
                setCloudState('signed-out', '已退出登录，本机歌单仍可继续使用');
                void refreshCloudPendingCount('');
                if (typeof refreshMyPlaylists === 'function') void refreshMyPlaylists();
            }
        }

        async function initializeCloudAccount() {
            try {
                await repairPendingCloudDetach();
            } catch (error) {
                setCloudState('error', '上次注销已删除云端账号，但本机标记尚未清理；请刷新后重试', error);
                return;
            }
            const config = getConfiguredCloud();
            if (!config) {
                cloudService = null;
                cloudSession = null;
                cloudUserId = '';
                cloudLastSuccessfulAt = 0;
                setCloudState('disabled', '云同步尚未配置，播放器仍可本地使用');
                void refreshCloudPendingCount('');
                return;
            }
            if (typeof window.supabase === 'undefined' ||
                typeof window.supabase.createClient !== 'function') {
                setCloudState('error', '云同步组件未加载，本机功能不受影响');
                return;
            }
            try {
                cloudService = new CPlayerCloudService({
                    config: config,
                    supabase: window.supabase,
                    storage: makeCloudStorageAdapter()
                });
                if (cloudAuthSubscription && typeof cloudAuthSubscription.unsubscribe === 'function') {
                    cloudAuthSubscription.unsubscribe();
                }
                cloudAuthSubscription = cloudService.onAuthStateChange(function (event, session) {
                    void Promise.resolve().then(function () {
                        handleCloudSession(event, session);
                    });
                });
                const session = await cloudService.getSession();
                handleCloudSession('INITIAL_SESSION', session);
            } catch (error) {
                cloudService = null;
                setCloudState('error', cloudErrorMessage(error, '云同步初始化失败，本机功能不受影响'), error);
            }
        }

        async function cloudSignIn() {
            if (!cloudService) return;
            let email;
            let password;
            try {
                email = getCloudEmailInput();
                password = getCloudPasswordInput();
            } catch (error) {
                showToast(error.message, true);
                return;
            }
            setCloudAccountBusy(true);
            try {
                const result = await cloudService.signIn(email, password);
                handleCloudSession('SIGNED_IN', result && result.session);
                showToast('登录成功');
            } catch (error) {
                setCloudState('error', cloudErrorMessage(error, '登录失败'), error);
                showToast(cloudErrorMessage(error, '登录失败'), true);
            } finally {
                clearCloudPasswordInputs();
                setCloudAccountBusy(false);
            }
        }

        async function cloudSignUp() {
            if (!cloudService) return;
            let email;
            let password;
            try {
                email = getCloudEmailInput();
                password = getCloudPasswordInput();
            } catch (error) {
                showToast(error.message, true);
                return;
            }
            setCloudAccountBusy(true);
            try {
                const result = await cloudService.signUp(email, password);
                if (result && result.session) {
                    handleCloudSession('SIGNED_IN', result.session);
                    showToast('注册成功，已登录');
                } else {
                    setCloudState('signed-out', '注册成功，请查收邮箱完成验证');
                    showToast('注册成功，请查收验证邮件');
                }
            } catch (error) {
                setCloudState('error', cloudErrorMessage(error, '注册失败'), error);
                showToast(cloudErrorMessage(error, '注册失败'), true);
            } finally {
                clearCloudPasswordInputs();
                setCloudAccountBusy(false);
            }
        }

        async function cloudRequestPasswordReset() {
            if (!cloudService) return;
            let email;
            try {
                email = getCloudEmailInput();
            } catch (error) {
                showToast(error.message, true);
                return;
            }
            setCloudAccountBusy(true);
            try {
                await cloudService.requestPasswordReset(email, cloudRedirectUrl());
                setCloudState('signed-out', '重置邮件已发送，请在邮箱中打开链接');
                showToast('重置邮件已发送');
            } catch (error) {
                setCloudState('error', cloudErrorMessage(error, '重置邮件发送失败'), error);
                showToast(cloudErrorMessage(error, '重置邮件发送失败'), true);
            } finally {
                clearCloudPasswordInputs();
                setCloudAccountBusy(false);
            }
        }

        async function cloudUpdatePassword() {
            if (!cloudService) return;
            let password;
            try {
                password = getCloudPasswordInput('cloudAccountNewPassword');
            } catch (error) {
                showToast(error.message, true);
                return;
            }
            setCloudAccountBusy(true);
            try {
                await cloudService.updatePassword(password);
                cloudRecoveryMode = false;
                const session = await cloudService.getSession();
                handleCloudSession('SIGNED_IN', session);
                showToast('密码已更新');
            } catch (error) {
                setCloudState('error', cloudErrorMessage(error, '密码更新失败'), error);
                showToast(cloudErrorMessage(error, '密码更新失败'), true);
            } finally {
                clearCloudPasswordInputs();
                setCloudAccountBusy(false);
            }
        }

        async function cloudSignOut() {
            if (!cloudService) return;
            setCloudAccountBusy(true);
            try {
                await cloudService.signOut();
                handleCloudSession('SIGNED_OUT', null);
                showToast('已退出登录');
            } catch (error) {
                setCloudState('error', cloudErrorMessage(error, '退出登录失败'), error);
                showToast(cloudErrorMessage(error, '退出登录失败'), true);
            } finally {
                setCloudAccountBusy(false);
            }
        }

        async function cloudDeleteAccount() {
            if (!cloudService || !cloudUserId) return;
            if (!confirm('注销后会删除云端账号和云端歌单，本机歌单会保留为本地数据。确定继续吗？')) return;
            const ownerId = cloudUserId;
            setCloudAccountBusy(true);
            let cloudDeleted = false;
            let detachError = null;
            let signOutError = null;
            const finishLocalSignOut = async function () {
                try { await cloudService.signOut(); } catch (error) { signOutError = error; }
                handleCloudSession('SIGNED_OUT', null);
            };
            try {
                if (!writeLocalStorage(CLOUD_DETACH_PENDING_KEY, JSON.stringify({
                    ownerId,
                    confirmed: false
                }))) {
                    throw new Error('注销前无法写入本机恢复标记');
                }
                await cloudService.deleteAccount();
                cloudDeleted = true;
                writeLocalStorage(CLOUD_DETACH_PENDING_KEY, JSON.stringify({
                    ownerId,
                    confirmed: true
                }));
                try {
                    await detachCloudOwner(ownerId);
                    forgetCloudSyncSuccess(ownerId);
                    forgetCloudSyncError(ownerId);
                    removeLocalStorage(CLOUD_DETACH_PENDING_KEY);
                } catch (error) {
                    detachError = error;
                }
                await finishLocalSignOut();
                if (detachError) {
                    const message = '账号已注销，但本机歌单标记清理失败；请刷新后重试，歌单内容仍保留';
                    setCloudState('error', message, detachError);
                    showToast(message, true);
                    return;
                }
                if (signOutError) {
                    const message = '账号已注销，本机歌单已保留；登录状态清理将在刷新后完成';
                    setCloudState('error', message, signOutError);
                    showToast(message, true);
                    return;
                }
                showToast('账号已注销，本机歌单已保留');
            } catch (error) {
                if (!cloudDeleted) {
                    removeLocalStorage(CLOUD_DETACH_PENDING_KEY);
                    const message = cloudErrorMessage(error, '账号注销失败，本机数据未改变');
                    setCloudState('error', message, error);
                    showToast(message, true);
                } else {
                    await finishLocalSignOut();
                    const message = '账号已注销，但本机清理步骤未完成；请刷新后重试，歌单内容仍保留';
                    setCloudState('error', message, error);
                    showToast(message, true);
                }
            } finally {
                setCloudAccountBusy(false);
            }
        }

        async function persistCloudOutbox(ownerId, localRecord, operation, expectedVersion) {
            if (!db || !hasCloudOutboxStore()) throw new Error('云同步存储未就绪');
            const history = operation === 'purge'
                ? []
                : await readPlaylistVersions(localRecord.id, { ownerId: ownerId });
            const outbox = makeCloudOutboxRecord(
                ownerId,
                localRecord,
                operation,
                expectedVersion,
                history
            );
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            if (operation !== 'purge') {
                tx.objectStore('playlists').put(Object.assign({}, localRecord, {
                    cloudOwnerId: ownerId,
                    cloudVersion: normalizeCloudVersion(expectedVersion),
                    cloudDirty: true
                }));
            }
            tx.objectStore(CLOUD_OUTBOX_STORE).put(outbox);
            await transactionDone(tx);
            return outbox;
        }

        function scheduleCloudSync(reason, delay) {
            if (!cloudService || !cloudUserId) return;
            void refreshCloudPendingCount(cloudUserId);
            if (navigator.onLine === false) {
                setCloudState('pending', '歌单已保存在本机，联网后同步');
                return;
            }
            if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
            cloudSyncTimer = setTimeout(function () {
                cloudSyncTimer = null;
                void syncCloudPlaylists(reason || 'scheduled');
            }, Number.isFinite(delay) ? Math.max(0, delay) : 400);
        }

        function rememberCloudConflict(ownerId, playlistId, local, remote, outbox, target) {
            const conflicts = target || cloudConflicts;
            conflicts.set(playlistId, {
                ownerId,
                playlistId,
                local: local || null,
                remote: remote || null,
                outbox: outbox || null
            });
            if (conflicts === cloudConflicts) {
                invalidateCloudHealthSnapshot('冲突集合已变化');
                setCloudState('conflict', '发现歌单冲突，请在设置中选择保留哪一份');
            }
        }

        async function latestRemotePlaylist(playlistId) {
            const rows = await cloudService.listPlaylists();
            return rows.find(function (row) { return row.id === playlistId; }) || null;
        }

        async function recoverCloudPlaylistCopy(ownerId, local, remote) {
            if (!local) throw new Error('没有可保留的本机歌单内容');
            const records = await readUserPlaylistRecords({
                includeForeign: true,
                includeTrash: true,
                includePurged: true
            });
            const ids = new Set(records.map(function (record) { return record.id; }));
            const recovered = await saveUserPlaylistRecord({
                id: createUserPlaylistId(ids),
                name: makeRecoveredPlaylistName(local.name),
                songs: Array.isArray(local.songs) ? local.songs : [],
                cloudOwnerId: ownerId,
                cloudVersion: 0,
                cloudDirty: true,
                deletedAt: 0,
                purgedAt: 0
            }, {
                operation: 'upsert',
                historyReason: 'restore'
            });
            if (remote) await applyRemotePlaylistToLocal(ownerId, remote);
            else await removeLocalCloudPlaylist(ownerId, local.id);
            showToast('较新的歌单已保留，恢复内容已另存为「' + recovered.name + '」');
            return recovered;
        }

        async function performCloudSync(reason, options) {
            options = options || {};
            const ownerId = cloudUserId;
            if (!cloudService || !ownerId) return false;
            if (navigator.onLine === false) {
                setCloudState('pending', '歌单已保存在本机，联网后同步');
                void refreshCloudPendingCount(ownerId);
                return false;
            }
            setCloudState('syncing', '正在同步歌单…');
            await adoptLocalPlaylistsForCloud(ownerId);
            await cloudService.cleanupPlaylistData();
            const results = await Promise.all([
                readUserPlaylistRecords({
                    includeForeign: true,
                    ownerId: ownerId,
                    includeTrash: true,
                    includePurged: true
                }),
                readCloudOutbox(ownerId),
                cloudService.listPlaylists()
            ]);
            if (cloudUserId !== ownerId) return false;

            const localMap = new Map(results[0].filter(function (record) {
                return record.cloudOwnerId === ownerId;
            }).map(function (record) { return [record.id, record]; }));
            const outboxMap = new Map(results[1].map(function (record) {
                return [record.playlistId, record];
            }));
            setCloudPendingCount(results[1].length);
            const remoteMap = new Map(results[2].map(function (record) {
                return [record.id, record];
            }));
            const playlistIds = new Set([
                ...localMap.keys(),
                ...outboxMap.keys(),
                ...remoteMap.keys()
            ]);
            const targetPlaylistId = typeof options.playlistId === 'string' ? options.playlistId : '';
            const idsToProcess = targetPlaylistId
                ? (playlistIds.has(targetPlaylistId) ? [targetPlaylistId] : [])
                : Array.from(playlistIds);
            const detectedConflicts = new Map();
            let changed = 0;

            for (const playlistId of idsToProcess) {
                if (cloudUserId !== ownerId) return false;
                const local = localMap.get(playlistId) || null;
                const remote = remoteMap.get(playlistId) || null;
                let outbox = outboxMap.get(playlistId) || null;
                const decision = decidePlaylistSync(local, remote, outbox);
                try {
                    if (decision.action === 'none') continue;
                    if (decision.action === 'pull' || decision.action === 'pull-delete' ||
                        decision.action === 'pull-purge' || decision.action === 'ack-restore') {
                        await applyRemotePlaylistToLocal(ownerId, remote);
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'ack-delete') {
                        await acknowledgeCloudDelete(ownerId, outbox, remote || { version: 0 });
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'ack-upsert') {
                        await acknowledgeCloudUpsert(ownerId, outbox, remote);
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'ack-purge') {
                        await acknowledgeCloudPurge(ownerId, outbox, remote || { version: 0 });
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'recover-copy') {
                        await recoverCloudPlaylistCopy(ownerId, local, remote);
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'conflict') {
                        rememberCloudConflict(ownerId, playlistId, local, remote, outbox, detectedConflicts);
                        continue;
                    }
                    if (decision.action === 'push') {
                        if (!local) continue;
                        if (!outbox) {
                            outbox = await persistCloudOutbox(ownerId, local, 'upsert', decision.expectedVersion);
                        }
                        const acknowledged = await cloudService.upsertPlaylist(
                            outbox.playlist || local,
                            decision.expectedVersion,
                            outbox.history || []
                        );
                        await acknowledgeCloudUpsert(ownerId, outbox, acknowledged);
                        if (cloudUserId !== ownerId) return false;
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'delete') {
                        if (!outbox) {
                            outbox = await persistCloudOutbox(
                                ownerId,
                                { id: playlistId },
                                'delete',
                                decision.expectedVersion
                            );
                        }
                        const acknowledged = await cloudService.deletePlaylist(
                            outbox.playlist || local,
                            decision.expectedVersion,
                            outbox.history || []
                        );
                        await acknowledgeCloudDelete(ownerId, outbox, acknowledged);
                        if (cloudUserId !== ownerId) return false;
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'purge') {
                        if (!outbox) continue;
                        const acknowledged = await cloudService.purgePlaylist(
                            playlistId,
                            decision.expectedVersion
                        );
                        await acknowledgeCloudPurge(ownerId, outbox, acknowledged);
                        if (cloudUserId !== ownerId) return false;
                        changed += 1;
                    }
                } catch (error) {
                    if (isCloudConflictError(error)) {
                        const latest = await latestRemotePlaylist(playlistId);
                        if (outbox && outbox.operation === 'restore' && latest) {
                            await recoverCloudPlaylistCopy(ownerId, local, latest);
                            changed += 1;
                            continue;
                        }
                        rememberCloudConflict(
                            ownerId,
                            playlistId,
                            local,
                            latest || remote,
                            outbox,
                            detectedConflicts
                        );
                        continue;
                    }
                    throw error;
                }
            }

            if (cloudUserId !== ownerId) return false;

            for (const [playlistId, conflict] of cloudConflicts) {
                if (conflict && conflict.ownerId === ownerId &&
                    (!targetPlaylistId || playlistId === targetPlaylistId)) {
                    cloudConflicts.delete(playlistId);
                }
            }
            for (const [playlistId, conflict] of detectedConflicts) {
                cloudConflicts.set(playlistId, conflict);
            }
            const remaining = await readCloudOutbox(ownerId);
            setCloudPendingItems(remaining, ownerId);
            setCloudPendingCount(remaining.length);
            if (cloudConflicts.size) {
                setCloudState('conflict', '发现 ' + cloudConflicts.size + ' 个歌单冲突，请选择保留哪一份');
            } else if (remaining.length) {
                setCloudState('pending', '仍有 ' + remaining.length + ' 项歌单修改等待同步');
            } else {
                rememberCloudSyncSuccess(ownerId);
                setCloudState('synced', changed
                    ? '歌单同步完成'
                    : '歌单已经是最新状态');
            }
            if (typeof refreshMyPlaylists === 'function') await refreshMyPlaylists();
            if (typeof refreshUserPlaylistLibrary === 'function') await refreshUserPlaylistLibrary();
            if (typeof refreshPlaylistTrash === 'function') await refreshPlaylistTrash();
            if (reason === 'manual') {
                if (cloudConflicts.size) {
                    showToast('发现 ' + cloudConflicts.size + ' 个冲突，请先选择保留哪一份', true);
                } else if (remaining.length) {
                    showToast('仍有 ' + remaining.length + ' 项修改等待同步', true);
                } else {
                    showToast('歌单同步完成');
                }
            }
            return true;
        }

        async function syncCloudPlaylists(reason, options) {
            if (!cloudService || !cloudUserId) {
                setCloudState(cloudService ? 'signed-out' : 'disabled',
                    cloudService ? '请先登录再同步' : '云同步尚未配置，播放器仍可本地使用');
                return false;
            }
            if (cloudSyncInFlight) {
                cloudSyncPendingReason = reason || 'queued';
                return cloudSyncInFlight;
            }
            const running = performCloudSync(reason || 'manual', options);
            cloudSyncInFlight = running;
            try {
                return await running;
            } catch (error) {
                const message = cloudErrorMessage(error, '同步失败，修改已保存在本机');
                setCloudState('error', message, error);
                void refreshCloudPendingCount(cloudUserId);
                if (reason === 'manual' || reason === 'retry_item' || reason === 'retry_all') showToast(message, true);
                return false;
            } finally {
                cloudSyncInFlight = null;
                if (cloudSyncPendingReason && cloudService && cloudUserId) {
                    const nextReason = cloudSyncPendingReason;
                    cloudSyncPendingReason = '';
                    scheduleCloudSync(nextReason, 0);
                }
            }
        }

        async function retryCloudOutboxItem(outboxId) {
            if (!cloudService || !cloudUserId) {
                showToast('请先登录对应账号再重试', true);
                return false;
            }
            if (navigator.onLine === false) {
                showToast('当前处于离线状态，联网后再重试', true);
                return false;
            }
            const item = cloudPendingItems.find(function (entry) { return entry.id === outboxId; });
            if (!item) {
                await refreshCloudPendingCount(cloudUserId);
                showToast('这项待同步修改已经处理或不再属于当前账号');
                return false;
            }
            setCloudAccountBusy(true);
            try {
                const ok = await syncCloudPlaylists('retry_item', { playlistId: item.playlistId });
                const remaining = await readCloudOutbox(cloudUserId);
                const stillPending = remaining.some(function (entry) { return entry.id === outboxId; });
                if (ok && !stillPending) showToast('歌单「' + item.name + '」已重试成功');
                else if (stillPending) showToast('歌单「' + item.name + '」仍待同步，请查看错误或冲突提示', true);
                return ok && !stillPending;
            } catch (error) {
                const message = cloudErrorMessage(error, '单项重试失败，本机数据仍保留');
                setCloudState('error', message, error);
                showToast(message, true);
                return false;
            } finally {
                setCloudAccountBusy(false);
            }
        }

        async function retryAllCloudOutbox() {
            if (!cloudService || !cloudUserId) {
                showToast('请先登录对应账号再重试', true);
                return false;
            }
            if (navigator.onLine === false) {
                showToast('当前处于离线状态，联网后再重试', true);
                return false;
            }
            setCloudAccountBusy(true);
            try {
                return await syncCloudPlaylists('retry_all');
            } finally {
                setCloudAccountBusy(false);
            }
        }

        async function resolveCloudConflict(useLocal) {
            const conflict = cloudConflicts.values().next().value || null;
            if (!conflict || conflict.ownerId !== cloudUserId || !cloudService) return;
            setCloudAccountBusy(true);
            try {
                if (useLocal) {
                    const remoteVersion = conflict.remote ? conflict.remote.version : 0;
                    let outbox = conflict.outbox;
                    if (outbox && outbox.operation === 'restore' && conflict.remote) {
                        await recoverCloudPlaylistCopy(conflict.ownerId, conflict.local, conflict.remote);
                    } else if (outbox && outbox.operation === 'delete') {
                        const acknowledged = await cloudService.deletePlaylist(
                            outbox.playlist || conflict.local,
                            remoteVersion,
                            outbox.history || []
                        );
                        await acknowledgeCloudDelete(conflict.ownerId, outbox, acknowledged);
                    } else if (outbox && outbox.operation === 'purge') {
                        const acknowledged = await cloudService.purgePlaylist(conflict.playlistId, remoteVersion);
                        await acknowledgeCloudPurge(conflict.ownerId, outbox, acknowledged);
                    } else {
                        if (!conflict.local) throw new Error('本机歌单已不存在');
                        if (!outbox) {
                            outbox = await persistCloudOutbox(
                                conflict.ownerId,
                                conflict.local,
                                'upsert',
                                remoteVersion
                            );
                        }
                        const acknowledged = await cloudService.upsertPlaylist(
                            outbox.playlist || conflict.local,
                            remoteVersion,
                            outbox.history || []
                        );
                        await acknowledgeCloudUpsert(conflict.ownerId, outbox, acknowledged);
                    }
                } else if (conflict.remote) {
                    await applyRemotePlaylistToLocal(conflict.ownerId, conflict.remote);
                } else {
                    await removeLocalCloudPlaylist(conflict.ownerId, conflict.playlistId);
                }
                cloudConflicts.delete(conflict.playlistId);
                setCloudState('pending', '冲突已处理，正在继续同步');
                await syncCloudPlaylists('conflict_resolution');
            } catch (error) {
                const message = cloudErrorMessage(error, '冲突处理失败，本机数据未改变');
                setCloudState('error', message, error);
                showToast(message, true);
            } finally {
                setCloudAccountBusy(false);
            }
        }

        function setupCloudAccountUI() {
            const card = document.getElementById('cloudAccountCard');
            if (!card || card.dataset.bound === '1') return;
            card.dataset.bound = '1';
            const bind = function (id, handler) {
                const button = document.getElementById(id);
                if (button) button.addEventListener('click', function () { void handler(); });
            };
            bind('cloudAccountSignInBtn', cloudSignIn);
            bind('cloudAccountSignUpBtn', cloudSignUp);
            bind('cloudAccountResetBtn', cloudRequestPasswordReset);
            bind('cloudAccountUpdatePasswordBtn', cloudUpdatePassword);
            bind('cloudAccountSignOutBtn', cloudSignOut);
            bind('cloudAccountDeleteBtn', cloudDeleteAccount);
            bind('cloudAccountSyncBtn', function () { return syncCloudPlaylists('manual'); });
            bind('cloudRetryAllBtn', retryAllCloudOutbox);
            bind('cloudAccountUseLocalBtn', function () { return resolveCloudConflict(true); });
            bind('cloudAccountUseCloudBtn', function () { return resolveCloudConflict(false); });
            const healthButton = document.getElementById('cloudHealthCheckBtn');
            if (healthButton) healthButton.addEventListener('click', function () { void runCloudHealthCheck(); });
            const healthExportButton = document.getElementById('cloudHealthCheckExportBtn');
            if (healthExportButton) healthExportButton.addEventListener('click', exportCloudHealthReport);
            refreshCloudAccountUI();
        }

        // ================= 设置 UI =================
        function initSettingsUI() {
            // 设置项的UI已精简，此处留空防报错
        }

        function openSettings() {
            try { if (typeof bindUserPlaylistUI === 'function') bindUserPlaylistUI(); if (typeof refreshUserPlaylistLibrary === 'function') refreshUserPlaylistLibrary(); } catch (e) {}

            delete dom.settingsModal.dataset.closing;
            dom.settingsModal.classList.remove('hidden');
            dom.settingsModal.setAttribute('aria-hidden', 'false');
            // Allow reflow
            void dom.settingsModal.offsetWidth;
            dom.settingsModal.classList.remove('opacity-0');
            dom.settingsModal.querySelector('.modal-card').classList.remove('scale-95');
            dom.settingsModal.querySelector('.modal-card').classList.add('scale-100');

            // 回显当前歌单 ID
            const idInput = document.getElementById('playlistIdInput');
            const savedId = readLocalStorage('cp_playlistId');
            if (idInput && savedId) idInput.value = savedId;

            // 回显 API 设置（密钥与地址，均只存在本机浏览器）
            refreshApiSettingsUI();
            refreshCloudAccountUI();

            // 刷新歌单来源状态
            updateSourceDisplay();
            openAccessibleOverlay(dom.settingsModal, {
                close: closeSettings,
                initialFocus: '#closeSettingsBtn'
            });
        }

        // 把已保存的密钥/地址回显到设置输入框，并显示当前生效状态。
        function refreshApiSettingsUI() {
            const keyInput = document.getElementById('settingsApiKeyInput');
            const baseInput = document.getElementById('settingsApiBaseInput');
            const status = document.getElementById('settingsApiStatus');
            const savedKey = (readLocalStorage('cp_api_key', '') || '').trim();
            const savedBase = (readLocalStorage('cp_api_base', '') || '').trim();
            let defaultBase = '';
            try { defaultBase = ChKSzAPI.defaultBaseUrl; } catch (e) { defaultBase = ''; }
            const effectiveBase = ChKSzAPI.normalizeBaseUrl(savedBase) || defaultBase;
            if (keyInput) keyInput.value = savedKey;
            if (baseInput) baseInput.value = effectiveBase;
            if (status) {
                const statusBase = effectiveBase || '未配置';
                status.textContent = (savedKey ? '已配置密钥' : '未配置密钥') + ' · 地址 ' + statusBase;
                status.title = status.textContent;
            }
        }

        // 保存 API 设置：写入 localStorage；后续请求会从统一构造器读取最新值。
        function saveApiSettings() {
            const keyInput = document.getElementById('settingsApiKeyInput');
            const baseInput = document.getElementById('settingsApiBaseInput');
            const key = keyInput ? keyInput.value.trim() : '';
            const rawBase = baseInput ? baseInput.value.trim() : '';
            const base = ChKSzAPI.normalizeBaseUrl(rawBase);
            if (rawBase && !base) {
                if (typeof showToast === 'function') showToast('请输入有效的 HTTP(S) API 地址', true);
                return;
            }
            let defaultBase = '';
            try { defaultBase = ChKSzAPI.defaultBaseUrl; } catch (e) {}
            const keySaved = key ? writeLocalStorage('cp_api_key', key) : removeLocalStorage('cp_api_key');
            const baseSaved = base && base !== defaultBase
                ? writeLocalStorage('cp_api_base', base)
                : removeLocalStorage('cp_api_base');
            if (!keySaved || !baseSaved) {
                if (typeof showToast === 'function') showToast('无法保存设置（浏览器存储不可用）', true);
                return;
            }
            refreshApiSettingsUI();
            if (typeof showToast === 'function') showToast('API 设置已保存');
        }

        // 恢复默认：清空密钥与自定义地址，回到页面 meta 的默认地址。
        function resetApiSettings() {
            const keyRemoved = removeLocalStorage('cp_api_key');
            const baseRemoved = removeLocalStorage('cp_api_base');
            if (!keyRemoved || !baseRemoved) {
                if (typeof showToast === 'function') showToast('无法恢复默认设置（浏览器存储不可用）', true);
                return;
            }
            refreshApiSettingsUI();
            if (typeof showToast === 'function') showToast('已恢复默认 API 设置');
        }

        function updateSourceDisplay() {
            const sourceLabel = document.getElementById('sourceLabel');
            const sourceDetail = document.getElementById('sourceDetail');
            const sourceIconI = document.getElementById('sourceIconI');
            const sourceCount = document.getElementById('sourceCount');
            if (!sourceLabel) return;

            const count = playlist ? playlist.length : 0;
            sourceCount.querySelector('div:first-child').textContent = count;

            const configs = {
                'local':       { icon: 'fas fa-hdd',            label: '本地 playlist.js',       detail: '同目录下的 playlist.js 文件自动加载' },
                'online':      { icon: 'fas fa-cloud',          label: '在线歌单',               detail: `歌单 ID: ${playlistSourceName}` },
                'cache':       { icon: 'fas fa-database',       label: '本地缓存',               detail: `歌单 ID: ${playlistSourceName}（来自 IndexedDB 缓存）` },
                'import-js':   { icon: 'fas fa-file-code',      label: '导入的 JS 歌单',         detail: `文件: ${playlistSourceName}` },
                'import-json': { icon: 'fas fa-file-alt',       label: '导入的 JSON 歌单',       detail: `文件: ${playlistSourceName}` },
                '':            { icon: 'fas fa-music',           label: '未加载歌单',             detail: '请输入歌单 ID 或导入文件' }
            };

            const cfg = configs[playlistSource] || configs[''];
            sourceIconI.className = cfg.icon + ' text-primary-color text-sm';
            sourceLabel.textContent = cfg.label;
            sourceDetail.textContent = cfg.detail;
        }

        function closeSettings() {
            if (dom.settingsModal.dataset.closing === '1') return;
            dom.settingsModal.dataset.closing = '1';
            dom.settingsModal.classList.add('opacity-0');
            dom.settingsModal.querySelector('.modal-card').classList.add('scale-95');
            dom.settingsModal.querySelector('.modal-card').classList.remove('scale-100');
            setTimeout(() => {
                dom.settingsModal.classList.add('hidden');
                closeAccessibleOverlay(dom.settingsModal);
                delete dom.settingsModal.dataset.closing;
            }, 300);
        }

        function setPlayerLoading(isLoading) {
            if (dom.desktopLoaderOverlay) dom.desktopLoaderOverlay.classList.toggle('opacity-0', !isLoading);
            if (dom.mobileLoaderOverlay) dom.mobileLoaderOverlay.classList.toggle('opacity-0', !isLoading);
        }

        function resolvePlaylistIndexBySongId(songId) {
            return playlist.findIndex(function (item) {
                return String(typeof item === 'object' ? item.id : item) === String(songId);
            });
        }

        function normalizePlayableUrl(value) {
            if (typeof value !== 'string' || !value.trim()) throw new Error('No playable URL returned');
            const raw = value.trim().replace(/^http:/i, 'https:');
            let parsed;
            try {
                parsed = new URL(raw, window.location.href);
            } catch (error) {
                throw new Error('Invalid media URL');
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported media URL');
            return parsed.href;
        }

        function isAutoplayPolicyError(error) {
            return !!error && error.name === 'NotAllowedError';
        }

        function getFailureCandidateIndex(attempt) {
            if (!playlist.length) return -1;
            let failedIndex = Number.isInteger(attempt.index) ? attempt.index : resolvePlaylistIndexBySongId(attempt.songId);
            const candidates = [];
            if (playMode === 'shuffle') {
                ensureShuffleOrder();
                const position = shuffledOrder.indexOf(failedIndex);
                const start = position < 0 ? -1 : position;
                for (let offset = 1; offset <= shuffledOrder.length; offset += 1) {
                    candidates.push(shuffledOrder[(start + offset) % shuffledOrder.length]);
                }
            } else {
                for (let index = Math.max(failedIndex + 1, 0); index < playlist.length; index += 1) candidates.push(index);
                if (playMode !== 'sequence') {
                    for (let index = 0; index < Math.max(failedIndex, 0); index += 1) candidates.push(index);
                }
            }
            return candidates.find(function (index) { return !attempt.failedIndexes.has(index); }) ?? -1;
        }

        function describeMediaError() {
            if (!audio.error) return 'Media element error';
            const messages = {
                1: 'Media loading aborted',
                2: 'Media network error',
                3: 'Media decode error',
                4: 'Media source unsupported'
            };
            return messages[audio.error.code] || 'Media element error';
        }

        async function handlePlaybackFailure(attempt, error, source) {
            if (!attempt || !activePlaybackAttempt || activePlaybackAttempt.token !== attempt.token || attempt.failureHandled) return false;
            attempt.failureHandled = true;
            const liveIndex = resolvePlaylistIndexBySongId(attempt.songId);
            if (liveIndex >= 0) attempt.index = liveIndex;
            if (Number.isInteger(attempt.index) && attempt.index >= 0) attempt.failedIndexes.add(attempt.index);
            console.error('[playback] ' + source + ' failed', {
                songId: attempt.songId,
                index: attempt.index,
                failedIndexes: Array.from(attempt.failedIndexes),
                error: error
            });
            const failure = classifyPlaybackFailure(error, navigator.onLine !== false);
            recordPlaybackDiagnostic({ attempt, error, source, category: failure.kind });

            if (failure.kind === 'auth') {
                try { audio.pause(); } catch (pauseError) {}
                applyPausedPlaybackState(false);
                setPlayerLoading(false);
                dom.lyricsContainer.innerHTML = '<div class="lyric-line opacity-50 my-auto">请在设置中检查 API 密钥</div>';
                if (typeof showToast === 'function') showToast(failure.message, true);
                return false;
            }

            const nextIndex = getFailureCandidateIndex(attempt);
            if (nextIndex < 0) {
                try { audio.pause(); } catch (pauseError) {}
                applyPausedPlaybackState(false);
                setPlayerLoading(false);
                dom.lyricsContainer.innerHTML = '<div class="lyric-line opacity-50 my-auto">当前范围内没有可播放歌曲</div>';
                if (typeof showToast === 'function') showToast(failure.message + '；当前范围内没有可播放歌曲', true);
                return false;
            }

            currentIndex = nextIndex;
            scheduleSaveCurrentQueue('playback_failure_skip');
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (typeof mobileUI !== 'undefined' && mobileUI && typeof mobileUI.loadPlaylist === 'function') mobileUI.loadPlaylist();
            const nextSong = playlist[nextIndex];
            const nextSongId = typeof nextSong === 'object' ? nextSong.id : nextSong;
            if (typeof showToast === 'function') showToast(failure.message + '，正在尝试下一首');
            loadAndPlaySong(nextSongId, {
                index: nextIndex,
                failedIndexes: attempt.failedIndexes,
                reason: 'failure_skip'
            });
            return true;
        }

        async function tryPlayAttempt(attempt, source) {
            if (!attempt || !activePlaybackAttempt || activePlaybackAttempt.token !== attempt.token ||
                !isAttemptCommitted(attempt)) return 'stale';
            try {
                await audio.play();
                return activePlaybackAttempt && activePlaybackAttempt.token === attempt.token ? 'playing' : 'stale';
            } catch (error) {
                if (!activePlaybackAttempt || activePlaybackAttempt.token !== attempt.token) return 'stale';
                if (isAutoplayPolicyError(error)) {
                    if (audio.paused) applyPausedPlaybackState(false);
                    recordPlaybackDiagnostic({ attempt, error, source: 'play', category: 'autoplay_blocked' });
                    console.info('[playback] waiting for user gesture', error);
                    if (typeof showToast === 'function') showToast('浏览器阻止了自动播放，请点击播放按钮');
                    return 'blocked';
                }
                if (error && error.name === 'AbortError') {
                    if (audio.paused) applyPausedPlaybackState(false);
                    recordPlaybackDiagnostic({ attempt, error, source: 'play', category: 'interrupted' });
                    console.info('[playback] play request interrupted', error);
                    return 'interrupted';
                }
                await handlePlaybackFailure(attempt, error, source || 'play');
                return 'failed';
            }
        }

        function recordRecentPlayForActiveAttempt() {
            const attempt = activePlaybackAttempt;
            if (!attempt || !isAttemptCommitted(attempt) || attempt.recentRecorded || !attempt.song || attempt.failureHandled) return;
            if (attempt.mediaUrl && audio.currentSrc && audio.currentSrc !== attempt.mediaUrl) return;
            attempt.recentRecorded = true;
            recordRecentPlay(attempt.song);
        }

        function handleAudioError() {
            const attempt = activePlaybackAttempt;
            if (!attempt || !isAttemptCommitted(attempt) || !attempt.mediaUrl || attempt.failureHandled) return;
            if (audio.currentSrc && audio.currentSrc !== attempt.mediaUrl) return;
            handlePlaybackFailure(attempt, new Error(describeMediaError()), 'media');
        }

        function onPlayStart() {
            isPlaying = true;
            markCommittedMediaReady();
            if (committedMedia) committedMedia.endedHandled = false;
            if (activePlaybackAttempt && isAttemptCommitted(activePlaybackAttempt) &&
                !activePlaybackAttempt.failureHandled) activePlaybackAttempt.failedIndexes.clear();
            dom.playPauseBtn.innerHTML = '<i class="fas fa-pause text-2xl text-on-primary-color"></i>';
            dom.albumArtWrapper.classList.add('playing');
            if (mobileUI) mobileUI.updatePlayState(true); // ★ Mobile
            if (!audioContext) setupAudioContext();
            else if (audioContext.state === 'suspended') audioContext.resume();

            setMediaSessionPlaybackState('playing');
            recordRecentPlayForActiveAttempt();
            savePlaybackSession('play', true);
            updateMediaSessionPositionState();
            syncVisualLifecycle();
        }

        function applyPausedPlaybackState(persistSession) {
            isPlaying = false;
            if (persistSession) savePlaybackSession('pause', true);
            dom.playPauseBtn.innerHTML = '<i class="fas fa-play text-2xl ml-1 text-on-primary-color"></i>';
            dom.albumArtWrapper.classList.remove('playing');
            if (mobileUI) mobileUI.updatePlayState(false); // ★ Mobile

            setMediaSessionPlaybackState(committedMedia ? 'paused' : 'none');
            updateMediaSessionPositionState();
            syncVisualLifecycle();
        }

        function onPlayPause() {
            applyPausedPlaybackState(true);
        }

        async function resumeCommittedMedia(source) {
            if (!committedMedia || !isCommittedMediaCurrent()) return false;
            if (activePlaybackAttempt && isAttemptCommitted(activePlaybackAttempt)) {
                return (await tryPlayAttempt(activePlaybackAttempt, source)) === 'playing';
            }
            try {
                await audio.play();
                return true;
            } catch (error) {
                if (audio.paused) applyPausedPlaybackState(false);
                if (isAutoplayPolicyError(error)) {
                    recordPlaybackDiagnostic({ attempt: activePlaybackAttempt, error, source: 'resume', category: 'autoplay_blocked' });
                    if (typeof showToast === 'function') showToast('浏览器阻止了自动播放，请再次点击播放');
                    return false;
                }
                recordPlaybackDiagnostic({ attempt: activePlaybackAttempt, error, source: 'resume', category: 'unknown' });
                console.error('[playback] committed media resume failed', error);
                if (typeof showToast === 'function') showToast('无法继续播放', true);
                return false;
            }
        }

        function togglePlayPause() {
            if (!audio.src || audio.readyState === 0) {
                // 如果还未加载过歌曲，直接播放播放列表中的当前或第一首歌
                if (playlist.length) {
                    if (currentIndex === -1) {
                        if (playMode === 'shuffle' && typeof shuffledOrder !== 'undefined' && shuffledOrder.length) {
                            currentIndex = shuffledOrder[0];
                        } else {
                            currentIndex = 0;
                        }
                    }
                    playSongAtIndex(currentIndex);
                }
            } else {
                if (isPlaying) {
                    audio.pause();
                } else if (committedMedia && isCommittedMediaCurrent()) {
                    resumeCommittedMedia('resume');
                }
            }
        }

        function handleExternalPlayRequest() {
            if (committedMedia && isCommittedMediaCurrent()) {
                return resumeCommittedMedia('media_session');
            }
            if (activePlaybackAttempt) return Promise.resolve(false);
            if (!committedMedia && (!audio.src || audio.readyState === 0) && playlist.length) {
                const index = currentIndex >= 0 && currentIndex < playlist.length ? currentIndex : 0;
                window.playSongAtIndex(index);
                return Promise.resolve(true);
            }
            return Promise.resolve(false);
        }


        const MEDIA_SESSION_SEEK_STEP_SECONDS = 10;

        function setMediaSessionPlaybackState(state) {
            if (!('mediaSession' in navigator)) return;
            try { navigator.mediaSession.playbackState = state; } catch (error) {
                console.warn('[media-session] playback state update failed', error);
            }
        }

        function clearMediaSessionState() {
            if (!('mediaSession' in navigator)) return;
            try { navigator.mediaSession.metadata = null; } catch (error) {}
            setMediaSessionPlaybackState('none');
            clearMediaSessionPositionState();
        }

        function clearMediaSessionPositionState() {
            if (!('mediaSession' in navigator)) return;
            if (typeof navigator.mediaSession.setPositionState === 'function') {
                try { navigator.mediaSession.setPositionState(); } catch (error) {}
            }
        }

        function updateMediaSessionPositionState() {
            if (!('mediaSession' in navigator) ||
                typeof navigator.mediaSession.setPositionState !== 'function' ||
                !committedMedia || !committedMedia.ready || !isCommittedMediaCurrent()) return false;
            const duration = Number(audio.duration);
            const position = clampMediaSeekTime(Number(audio.currentTime), duration);
            const playbackRate = Number(audio.playbackRate);
            if (position === null || !Number.isFinite(playbackRate) || playbackRate <= 0) return false;
            try {
                navigator.mediaSession.setPositionState({ duration, position, playbackRate });
                return true;
            } catch (error) {
                console.warn('[media-session] position update failed', error);
                return false;
            }
        }

        function seekMainAudio(target, options) {
            const safeTarget = clampMediaSeekTime(target, Number(audio.duration));
            if (safeTarget === null) return false;
            options = options || {};
            try {
                if (options.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(safeTarget);
                else audio.currentTime = safeTarget;
            } catch (error) {
                console.warn('[playback] seek failed', error);
                return false;
            }
            updatePlayerState();
            updateMediaSessionPositionState();
            return true;
        }

        function setupMediaSessionHandlers() {
            if (!('mediaSession' in navigator)) return false;
            const getSeekOffset = (details) => {
                if (!details || details.seekOffset === undefined) return MEDIA_SESSION_SEEK_STEP_SECONDS;
                const requested = Number(details.seekOffset);
                return Number.isFinite(requested) && requested > 0 ? requested : null;
            };
            const actionHandlers = [
                ['play', handleExternalPlayRequest],
                ['pause', () => audio.pause()],
                ['previoustrack', playPreviousSong],
                ['nexttrack', playNextSong],
                ['seekbackward', (details) => {
                    const offset = getSeekOffset(details);
                    if (offset === null) return;
                    seekMainAudio(Number(audio.currentTime) - offset);
                }],
                ['seekforward', (details) => {
                    const offset = getSeekOffset(details);
                    if (offset === null) return;
                    seekMainAudio(Number(audio.currentTime) + offset);
                }],
                ['seekto', (details) => seekMainAudio(
                    details && details.seekTime,
                    { fastSeek: !!(details && details.fastSeek) }
                )]
            ];

            for (const [action, handler] of actionHandlers) {
                try {
                    navigator.mediaSession.setActionHandler(action, handler);
                } catch (error) {
                    console.warn(`The media session action "${action}" is not supported yet.`);
                }
            }
            console.log('🎛️ MediaSession 已启用 (Enhanced)');
            return true;
        }

        function resetPlaybackIdentity() {
            playbackAttemptCounter += 1;
            activePlaybackAttempt = null;
            committedMedia = null;
            preloadedNextMedia = null;
            clearPlaybackSession();
            isPlaying = false;
            try { audio.pause(); } catch (error) {}
            try {
                audio.removeAttribute('src');
                audio.load();
            } catch (error) {}
            try {
                preloadAudio.pause();
                preloadAudio.removeAttribute('src');
                preloadAudio.load();
            } catch (error) {}
            clearMediaSessionState();
            syncVisualLifecycle();
            if (dom.playPauseBtn) dom.playPauseBtn.innerHTML = '<i class="fas fa-play text-2xl ml-1 text-on-primary-color"></i>';
            if (dom.albumArtWrapper) dom.albumArtWrapper.classList.remove('playing');
            if (dom.progressBar) dom.progressBar.style.width = '0%';
            if (dom.currentTime) dom.currentTime.textContent = '0:00';
            if (dom.totalTime) dom.totalTime.textContent = '0:00';
            if (mobileUI) {
                mobileUI.updatePlayState(false);
                mobileUI.updateProgress(0, 0, 0);
            }
            setPlayerLoading(false);
        }

        // ★ Helper for MediaSession
        function updateMediaSessionMetadata(data) {
            if (!('mediaSession' in navigator)) return;

            const artwork = [];
            if (data.cover) {
                const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
                const src = data.cover.replace(/^http:/, 'https:');
                sizes.forEach(size => {
                    artwork.push({
                        src: src,
                        sizes: size,
                        type: 'image/jpeg'
                    });
                });
            }

            navigator.mediaSession.metadata = new MediaMetadata({
                title: data.name || '未知歌曲',
                artist: data.artist || '未知艺术家',
                album: data.album || 'CPlayer 5',
                artwork: artwork
            });
        }

        async function loadAndPlaySong(id, options) {
            options = options || {};
            const token = ++playbackAttemptCounter;
            let index = Number.isInteger(options.index) ? options.index : resolvePlaylistIndexBySongId(id);
            if (index < 0 && currentIndex >= 0 && currentIndex < playlist.length) {
                const currentSong = playlist[currentIndex];
                const currentSongId = typeof currentSong === 'object' ? currentSong.id : currentSong;
                if (String(currentSongId) === String(id)) index = currentIndex;
            }
            let resumeTime = Number(options.resumeTime);
            if (!Number.isFinite(resumeTime) || resumeTime < 5) resumeTime = getPlaybackResumeTime(index);
            if (pendingPlaybackSession && String(id) !== pendingPlaybackSession.songId) clearPlaybackSession();
            const attempt = {
                token: token,
                index: index,
                songId: String(id),
                failedIndexes: options.failedIndexes instanceof Set ? options.failedIndexes : new Set(),
                failureHandled: false,
                recentRecorded: false,
                mediaUrl: '',
                song: null,
                resumeTime: Number.isFinite(resumeTime) ? resumeTime : 0,
                reason: options.reason || 'user'
            };
            activePlaybackAttempt = attempt;
            const prefetchedMedia = options.prefetchedMedia &&
                options.prefetchedMedia.status === 'ready' &&
                options.prefetchedMedia.index === index &&
                options.prefetchedMedia.songId === String(id) &&
                options.prefetchedMedia.data && options.prefetchedMedia.mediaUrl
                ? options.prefetchedMedia
                : null;
            if (!prefetchedMedia && preloadedNextMedia) discardPreloadedNextMedia();
            setPlayerLoading(true);
            dom.progressBar.style.width = '0%';
            dom.currentTime.textContent = '0:00';
            dom.lyricsContainer.innerHTML = '<div class="lyric-line opacity-50 my-auto">加载中...</div>';
            dom.sourceTag.textContent = 'CHKSZ API';
            dom.songIdTag.textContent = 'ID: Load...';
            renderPlaybackQuality({
                text: '音质确认中',
                className: 'quality-unknown',
                icon: '',
                detail: '正在等待上游 API 返回实际音质信息'
            });

            try {
                const data = prefetchedMedia ? prefetchedMedia.data : await musicService.getSong(id);
                if (!activePlaybackAttempt || activePlaybackAttempt.token !== token) return;
                if (!data) throw new Error('Song API returned no data');
                const mediaUrl = normalizePlayableUrl(data.url);
                const queueSong = index >= 0 && index < playlist.length && typeof playlist[index] === 'object' ? playlist[index] : {};
                const song = normalizeSongObject({
                    id: data.id != null ? data.id : id,
                    name: data.name || queueSong.name,
                    artist: data.artist || queueSong.artist,
                    cover: data.cover || queueSong.cover,
                    album: data.album || queueSong.album,
                    source: data.source || queueSong.source || 'ChKSz'
                });
                attempt.song = song;
                attempt.songId = String(song.id);
                attempt.mediaUrl = mediaUrl;
                attempt.index = resolvePlaylistIndexBySongId(song.id);
                if (attempt.index >= 0) {
                    currentIndex = attempt.index;
                    scheduleSaveCurrentQueue('play_song');
                }

                if (attempt.resumeTime >= 5) {
                    audio.addEventListener('loadedmetadata', function applySavedPlaybackPosition() {
                        if (!activePlaybackAttempt || activePlaybackAttempt.token !== token) return;
                        const target = getSafePlaybackResumeTime(attempt.resumeTime, audio.duration);
                        if (!target) {
                            clearPlaybackSession();
                            return;
                        }
                        audio.currentTime = target;
                        pendingPlaybackSession = null;
                        savePlaybackSession('resume_applied', true);
                        if (typeof showToast === 'function') showToast('已从 ' + formatTime(target) + ' 继续播放');
                    }, { once: true });
                }
                audio.src = mediaUrl;
                commitMediaIdentity(attempt, mediaUrl);
                applyPausedPlaybackState(false);
                dom.songTitle.textContent = song.name;
                dom.artistName.textContent = song.artist;
                dom.sourceTag.textContent = String(data.source || 'CHKSZ').toUpperCase() + ' API';
                dom.songIdTag.textContent = 'ID: ' + song.id;
                renderPlaybackQuality(classifyPlaybackQuality({
                    level: data.level,
                    url: data.url,
                    bitrate: data.br ?? data.bitrate
                }));
                updateMediaSessionMetadata(Object.assign({}, data, song));

                LyricService.fetchLyrics(song.id).then(function (lyrics) {
                    if (!activePlaybackAttempt || activePlaybackAttempt.token !== token) return;
                    parseLyrics(lyrics?.lrc || data.lrc || '', lyrics?.tlrc || data.tlrc || '');
                }).catch(function (error) {
                    if (activePlaybackAttempt && activePlaybackAttempt.token === token) {
                        console.warn('[lyrics] load failed', error);
                        parseLyrics(data.lrc || '', data.tlrc || '');
                    }
                });

                const picUrl = song.cover ? song.cover.replace(/^http:/, 'https:') : '';
                if (picUrl) {
                    dom.albumArt.src = picUrl;
                    if (fluidBg && typeof fluidBg.extractColorsFromImage === 'function') {
                        fluidBg.extractColorsFromImage(picUrl);
                    }
                    const coverImg = new Image();
                    coverImg.crossOrigin = 'anonymous';
                    coverImg.onload = function () {
                        if (activePlaybackAttempt && activePlaybackAttempt.token === token) {
                            updateMediaSessionMetadata(Object.assign({}, data, song));
                        }
                    };
                    coverImg.src = picUrl;
                }
                highlightCurrentSong();
                if (mobileUI) {
                    mobileUI.updateInfo(song.name, song.artist, picUrl);
                    mobileUI.resetView();
                    mobileUI.closeSheet();
                }

                const playResult = await tryPlayAttempt(attempt, 'play');
                if (playResult === 'playing') {
                    preloadNextSong(attempt);
                }
            } catch (error) {
                if (activePlaybackAttempt && activePlaybackAttempt.token === token) {
                    await handlePlaybackFailure(attempt, error, 'load');
                    if (mobileUI) mobileUI.closeSheet();
                }
            } finally {
                if (activePlaybackAttempt && activePlaybackAttempt.token === token) setPlayerLoading(false);
            }
        }

        function syncProgressAccessibility(element, currentTime, duration) {
            if (!element) return;
            const validDuration = Number.isFinite(duration) && duration > 0;
            const safeCurrent = validDuration ? Math.max(0, Math.min(duration, Number(currentTime) || 0)) : 0;
            const percent = validDuration ? (safeCurrent / duration) * 100 : 0;
            element.setAttribute('aria-valuenow', String(Math.round(percent)));
            element.setAttribute('aria-valuetext', formatTime(safeCurrent) + ' / ' + formatTime(validDuration ? duration : 0));
            element.setAttribute('aria-disabled', String(!validDuration));
        }

        function handleProgressKeydown(event) {
            if (!audio.duration || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            let nextTime = audio.currentTime;
            if (event.key === 'Home') nextTime = 0;
            else if (event.key === 'End') nextTime = audio.duration;
            else nextTime += event.key === 'ArrowRight' ? 5 : -5;
            seekMainAudio(nextTime);
        }

        function updatePlayerState() {
            if (!audio.duration) {
                syncProgressAccessibility(dom.progressBarContainer, 0, 0);
                syncProgressAccessibility(document.getElementById('mobileProgressBarContainer'), 0, 0);
                return;
            }
            const pct = (audio.currentTime / audio.duration) * 100;
            dom.progressBar.style.width = `${pct}%`;
            dom.currentTime.textContent = formatTime(audio.currentTime);
            syncProgressAccessibility(dom.progressBarContainer, audio.currentTime, audio.duration);

            // ★ Mobile Update
            if (mobileUI) mobileUI.updateProgress(audio.currentTime, audio.duration, pct);

            updateLyrics(audio.currentTime);
            savePlaybackSession('timeupdate', false);
            updateMediaSessionPositionState();
        }

        function seekAudio(e) {
            if (!audio.duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            seekMainAudio(pct * audio.duration);
        }

        // ================= 歌词逻辑 =================

        // 解析普通LRC歌词
        function parseLrc(text) {
            if (!text) return [];
            const lines = text.split('\n');
            const res = [];
            const regex = /^\[(\d{1,3}):(\d{1,2})(\.\d{1,3})?\](.*)/;

            for (let line of lines) {
                line = line.trim();
                // 跳过JSON元数据
                if (line.startsWith('{')) continue;

                const match = line.match(regex);
                if (match) {
                    const min = parseInt(match[1]);
                    const sec = parseInt(match[2]);
                    const msStr = match[3] ? match[3].substring(1) : '0';
                    const ms = parseInt(msStr.padEnd(3, '0').substring(0, 3));
                    const time = min * 60 + sec + ms / 1000;
                    const content = match[4].trim();
                    if (content) res.push({ time, text: content });
                }
            }
            return res;
        }

        function parseLyrics(lrc, tlrc) {
            // 解析普通歌词和翻译
            const origin = parseLrc(lrc);
            const trans = parseLrc(tlrc);

            // 创建翻译映射，使用更宽松的时间匹配（0.5秒容差）
            const findTranslation = (time) => {
                if (!trans || trans.length === 0) return null;

                // 精确匹配
                const exact = trans.find(t => Math.abs(t.time - time) < 0.5);
                if (exact) return exact.text;

                // 尝试四舍五入匹配
                const rounded = trans.find(t => t.time.toFixed(0) === time.toFixed(0));
                if (rounded) return rounded.text;

                return null;
            };

            parsedLyrics = origin.map(item => {
                const tText = findTranslation(item.time);

                return {
                    time: item.time,
                    text: item.text,
                    translation: tText || null
                };
            });
            renderLyrics();
        }

        function renderLyrics() {
            // Plan B: 使用 DOM 渲染
            const scroller = document.getElementById('lyricsScroller');
            const mobileScroller = document.getElementById('mobileLyricsScroller'); // ★ Mobile

            if (scroller) scroller.innerHTML = '';
            if (mobileScroller) mobileScroller.innerHTML = '';

            if (!parsedLyrics.length) {
                const emptyHTML = '<div class="lrc-line active"><span class="lrc-text">纯音乐 / 暂无歌词</span></div>';
                if (scroller) scroller.innerHTML = emptyHTML;
                if (mobileScroller) mobileScroller.innerHTML = emptyHTML;
                return;
            }

            const frag = document.createDocumentFragment();
            // Clone for mobile
            const mobileFrag = document.createDocumentFragment();

            parsedLyrics.forEach((line, idx) => {
                const div = document.createElement('div');
                div.className = 'lrc-line';
                div.dataset.time = line.time;
                div.dataset.idx = idx;
                div.setAttribute('role', 'button');
                div.tabIndex = 0;
                div.setAttribute('aria-label', '跳转到 ' + formatTime(line.time) + '：' + line.text);

                // Click to seek
                const activateDesktopLyric = () => {
                    audio.currentTime = line.time;
                    audio.play();
                };
                div.onclick = activateDesktopLyric;
                div.onkeydown = (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    activateDesktopLyric();
                };

                const spanMain = document.createElement('span');
                spanMain.className = 'lrc-text';
                spanMain.textContent = line.text;
                div.appendChild(spanMain);

                if (line.translation) {
                    const spanTrans = document.createElement('span');
                    spanTrans.className = 'lrc-trans';
                    spanTrans.textContent = line.translation;
                    div.appendChild(spanTrans);
                }

                frag.appendChild(div);
                // Mobile uses same structure, clone it
                // We need to re-attach event listener because cloneNode doesn't copy events
                const mobileDiv = div.cloneNode(true);
                const activateMobileLyric = () => {
                    // Prevent jump if mobile playlist sheet is open
                    if (mobileUI && mobileUI.dom.sheet.classList.contains('translate-y-0')) return;

                    audio.currentTime = line.time;
                    audio.play();
                };
                mobileDiv.onclick = activateMobileLyric;
                mobileDiv.onkeydown = (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    activateMobileLyric();
                };
                mobileFrag.appendChild(mobileDiv);
            });

            if (scroller) scroller.appendChild(frag);
            if (mobileScroller) mobileScroller.appendChild(mobileFrag);

            activeLyricIndex = -1;
        }

        function updateLyrics(time) {
            if (!parsedLyrics.length) return;

            // 1. Find active index
            let idx = parsedLyrics.findIndex(l => l.time > time + 0.3);
            idx = idx === -1 ? parsedLyrics.length - 1 : idx - 1;
            if (idx < 0) idx = 0;

            // 2. Update if changed
            if (idx !== activeLyricIndex) {
                activeLyricIndex = idx;

                const updateScroller = (scrollerId) => {
                    const scroller = document.getElementById(scrollerId);
                    if (!scroller) return;

                    const lines = scroller.getElementsByClassName('lrc-line');
                    const oldActive = scroller.querySelector('.active');
                    if (oldActive) oldActive.classList.remove('active');

                    if (lines[idx]) {
                        lines[idx].classList.add('active');

                        // Scroll logic
                        const containerHeight = scroller.clientHeight;
                        const lineTop = lines[idx].offsetTop;
                        const lineHeight = lines[idx].clientHeight;
                        const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);

                        scroller.scrollTo({
                            top: targetScroll,
                            behavior: 'smooth'
                        });
                    }
                };

                updateScroller('lyricsScroller');
                updateScroller('mobileLyricsScroller'); // ★ Mobile Sync
            }
        }



        // ================= 歌单逻辑 =================
        let currentPlaylistId = readLocalStorage('cp_playlistId', '') || '';
        let playlistTotalCount = 0;
        let isLoadingPlaylist = false;
        let allSongsLoaded = false;

        // 歌单来源追踪: 'local' | 'online' | 'cache' | 'import-js' | 'import-json' | ''
        let playlistSource = '';
        let playlistSourceName = ''; // 用于显示的附加信息（如歌单ID、文件名）

        // 歌单服务 - ChKSz API（无分页，一次获取全部）
        class PlaylistService {
            static async fetchPlaylist(listId) {
                const url = ChKSzAPI.buildUrl('/163_playlist', { id: listId });
                try {
                    const json = await fetchJsonWithTimeout(url);

                    let tracks = [];
                    // 兼容多种返回格式
                    if (json.data && Array.isArray(json.data.tracks)) {
                        tracks = json.data.tracks;
                    } else if (json.data && Array.isArray(json.data)) {
                        tracks = json.data;
                    } else if (json.playlist && Array.isArray(json.playlist.tracks)) {
                        tracks = json.playlist.tracks;
                    }

                    // 标准化歌曲数据格式（兼容 ar/al 和 artists/album 两种结构）
                    return tracks.map(item => ({
                        id: item.id,
                        name: item.name || '未知歌曲',
                        artist: item.artists
                            ? (typeof item.artists === 'string' ? item.artists : (Array.isArray(item.artists) ? item.artists.map(a => a.name).join('/') : 'Unknown'))
                            : (item.ar ? item.ar.map(a => a.name).join('/') : 'Unknown'),
                        album: typeof item.album === 'string' ? item.album : (item.al ? item.al.name : ''),
                        cover: item.picUrl || (item.al ? item.al.picUrl : '') || ''
                    }));
                } catch (e) {
                    const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
                    console.warn('Playlist fetch failed:', e);
                    if (failure.kind === 'auth') throw e;
                }
                return [];
            }
        }

        function handlePlaylistUpload(e) {
            handlePlaylistFile(e.target.files[0]);
        }

        function handlePlaylistFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (Array.isArray(data)) {
                        playlist = data.map(normalizeSongObject).filter(function (song) {
                            return song && song.id != null && String(song.id).trim();
                        });
                        currentIndex = -1;
                        currentPlaylistId = '';
                        removeLocalStorage('cp_playlistId');
                        playlistTotalCount = playlist.length;
                        allSongsLoaded = true;
                        playlistSource = 'import-json';
                        playlistSourceName = file.name;
                        window.playlist = playlist;
                        initPlaylistView();
                        if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
                        scheduleSaveCurrentQueue('import_json');
                        dom.uploadContainer.classList.add('hidden');
                        // dom.playlistInfo.classList.remove('hidden');
                    }
                } catch (err) {
                    showToast('歌单格式错误', true);
                }
            };
            reader.readAsText(file);
        }

        // 加载指定歌单
        async function loadPlaylistById(listId) {
            currentPlaylistId = listId;
            writeLocalStorage('cp_playlistId', listId);

            playlist = [];
            // Keep the published queue in step with the cleared one: a load that
            // fails after this point must not leave the previous songs visible.
            window.playlist = playlist;
            currentIndex = -1;
            allSongsLoaded = false;
            renderedCount = 0;

            dom.uploadContainer.classList.add('hidden');
            dom.playlistContent.innerHTML = '<div class="text-center py-4 opacity-50"><i class="fas fa-spinner fa-spin mr-2"></i>正在加载歌单...</div>';
            document.getElementById('playlistCount').textContent = '(加载中...)';

            // ★ 先尝试从 IndexedDB 缓存加载
            try {
                const cached = await getPlaylistFromCache(listId);
                if (cached && cached.songs && cached.songs.length > 0) {
                    console.log('💾 从缓存加载歌单:', cached.songs.length, '首');
                    playlist = cached.songs;
                    window.playlist = playlist;
                    scheduleSaveCurrentQueue('load_cache');
                    playlistTotalCount = playlist.length;
                    allSongsLoaded = true;
                    playlistSource = 'cache';
                    playlistSourceName = listId;
                    initPlaylistView();
                    document.getElementById('playlistCount').textContent = `(${playlist.length}首)`;

                    // 后台静默更新缓存
                    setTimeout(() => refreshPlaylistInBackground(listId), 5000);
                    return;
                }
            } catch (e) {
                console.warn('缓存读取失败:', e);
            }

            // 从 API 加载
            await fetchAndLoadPlaylist(listId);
        }

        // 后台静默更新歌单缓存
        async function refreshPlaylistInBackground(listId) {
            console.log('🔄 后台更新播放列表缓存...');
            try {
                const freshSongs = await PlaylistService.fetchPlaylist(listId);
                if (freshSongs.length > 0) {
                    const cached = await savePlaylistToCache(listId, freshSongs);
                    if (cached) console.log('✅ 播放列表缓存已更新:', freshSongs.length, '首');
                }
            } catch (e) {
                const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
                if (failure.kind === 'auth' && typeof showToast === 'function') {
                    showToast(failure.message, true);
                }
                console.warn('后台更新失败:', e);
            }
        }

        // 从 API 获取并加载歌单（单次请求）
        async function fetchAndLoadPlaylist(listId) {
            isLoadingPlaylist = true;
            try {
                const songs = await PlaylistService.fetchPlaylist(listId);

                if (songs.length === 0) {
                    throw new Error('歌单为空或不存在');
                }

                playlist = songs;
                window.playlist = playlist;
                scheduleSaveCurrentQueue('load_online');
                playlistTotalCount = playlist.length;
                allSongsLoaded = true;
                playlistSource = 'online';
                playlistSourceName = listId;

                document.getElementById('playlistCount').textContent = `(${playlist.length}首)`;
                initPlaylistView();

                // ★ 保存到 IndexedDB 缓存
                const cached = await savePlaylistToCache(listId, playlist);
                if (cached) console.log('💾 播放列表已缓存:', playlist.length, '首');

            } catch (e) {
                console.error('播放列表加载失败:', e);
                const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
                showToast(
                    failure.kind === 'auth'
                        ? failure.message
                        : '播放列表加载失败，请检查歌单ID是否正确',
                    true
                );
                throw e;
            } finally {
                isLoadingPlaylist = false;
                const loader = document.getElementById('playlistLoader');
                if (loader) loader.classList.add('hidden');
            }
        }

        async function loadDefaultPlaylist() {
            try {
                if (window.LOCAL_PLAYLIST && window.LOCAL_PLAYLIST.data && window.LOCAL_PLAYLIST.data.tracks) {
                    if (db) {
                        try {
                            const existingQueue = await getPlaylistFromCache(CURRENT_QUEUE_KEY);
                            queueBaseRevision = normalizeQueueRevision(existingQueue && existingQueue.revision);
                            queueWriteBlocked = false;
                        } catch (error) {
                            console.warn('[queue] unable to adopt stored revision before playlist.js load', error);
                        }
                    }
                    const tracks = window.LOCAL_PLAYLIST.data.tracks;
                    suppressQueueAutosave = true;
                    playlist = tracks.map(function (item) {
                        return {
                            id: item.id,
                            name: item.name,
                            artist: item.artists || 'Unknown',
                            cover: item.picUrl || '',
                            album: item.album || ''
                        };
                    });
                    window.playlist = playlist;
                    playlistTotalCount = playlist.length;
                    allSongsLoaded = true;
                    playlistSource = 'local';
                    playlistSourceName = window.LOCAL_PLAYLIST.title || 'playlist.js';
                    if (typeof initPlaylistView === 'function') initPlaylistView();
                    suppressQueueAutosave = false;
                    if (typeof scheduleSaveCurrentQueue === 'function') scheduleSaveCurrentQueue('boot_js');
                    return;
                }

                const savedId = readLocalStorage('cp_playlistId');
                let restored = await restoreCurrentQueue();
                if (restored) return;
                if (savedId && typeof loadPlaylistById === 'function') {
                    await loadPlaylistById(savedId);
                    return;
                }

                // empty start - searchable, no forced modal
                playlist = [];
                window.playlist = playlist;
                currentIndex = -1;
                allSongsLoaded = true;
                playlistSource = 'empty';
                playlistSourceName = '直接搜索';
                if (typeof initPlaylistView === 'function') initPlaylistView();
            } catch (e) {
                console.error('[boot]', e);
            } finally {
                preparePlaybackResume();
            }
        }

        // 从输入值中提取歌单 ID（支持纯数字、完整链接）
        function extractPlaylistId(raw) {
            const s = String(raw || '').trim();
            const m = s.match(/(\d{5,})/);
            return m ? m[1] : '';
        }

        // 解析 playlist.js 文件内容（window.LOCAL_PLAYLIST = {...};）
        function parsePlaylistJsContent(text) {
            // 尝试提取 JSON 对象
            const match = text.match(/window\.LOCAL_PLAYLIST\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
            if (match) {
                try {
                    const obj = JSON.parse(match[1]);
                    if (obj && obj.data && Array.isArray(obj.data.tracks)) {
                        return obj.data.tracks.map(item => ({
                            id: item.id,
                            name: item.name || '未知歌曲',
                            artist: typeof item.artists === 'string'
                                ? item.artists
                                : (Array.isArray(item.artists)
                                    ? item.artists.map(a => typeof a === 'string' ? a : a.name).join('/')
                                    : (Array.isArray(item.ar) ? item.ar.map(a => a.name).join('/') : 'Unknown')),
                            cover: item.picUrl || (item.al ? item.al.picUrl : '') || '',
                            album: typeof item.album === 'string'
                                ? item.album
                                : (item.album?.name || item.al?.name || '')
                        }));
                    }
                } catch (e) {
                    console.warn('playlist.js JSON parse failed:', e);
                }
            }
            return null;
        }

        // 处理导入的文件（.js 或 .json）
        function handleImportedFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target.result;
                const isJs = file.name.endsWith('.js');

                if (isJs) {
                    const tracks = parsePlaylistJsContent(text);
                    if (tracks && tracks.length > 0) {
                        playlist = tracks;
                        window.playlist = playlist;
                        currentIndex = -1;
                        playlistTotalCount = playlist.length;
                        allSongsLoaded = true;
                        playlistSource = 'import-js';
                        playlistSourceName = file.name;
                        initPlaylistView();
                        showToast(`已导入 ${playlist.length} 首歌曲`);
                        closeSettings();
                        return;
                    }
                    showToast('无法解析该 .js 文件，请确认格式正确', true);
                    return;
                }

                // JSON 格式
                handlePlaylistFile(file);
                closeSettings();
            };
            reader.readAsText(file);
        }

        // 手动加载歌单按钮事件
        function setupPlaylistIdLoader() {
            const btn = document.getElementById('loadPlaylistBtn');
            const input = document.getElementById('playlistIdInput');

            if (btn && input) {
                btn.onclick = () => {
                    const id = extractPlaylistId(input.value);
                    if (id) {
                        loadPlaylistById(id).catch(function () {
                            // fetchAndLoadPlaylist already reports the actionable error.
                        });
                        closeSettings();
                    } else {
                        showToast('请输入有效的歌单 ID（至少5位数字）', true);
                    }
                };

                input.onkeypress = (e) => {
                    if (e.key === 'Enter') btn.click();
                };
            }

            // 设置模态框内的拖拽区域
            const dropZone = document.getElementById('settingsDropZone');
            const fileInput = document.getElementById('settingsFileInput');

            if (dropZone && fileInput) {
                dropZone.addEventListener('click', () => fileInput.click());
                dropZone.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    fileInput.click();
                });

                fileInput.addEventListener('change', (e) => {
                    if (e.target.files[0]) handleImportedFile(e.target.files[0]);
                });

                dropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropZone.classList.add('border-primary-color/60', 'bg-white/[0.06]');
                });

                dropZone.addEventListener('dragleave', () => {
                    dropZone.classList.remove('border-primary-color/60', 'bg-white/[0.06]');
                });

                dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    dropZone.classList.remove('border-primary-color/60', 'bg-white/[0.06]');
                    const file = e.dataTransfer.files[0];
                    if (file && (file.name.endsWith('.js') || file.name.endsWith('.json'))) {
                        handleImportedFile(file);
                    } else {
                        showToast('请拖入 .js 或 .json 文件', true);
                    }
                });
            }

            // 全局拖拽支持（拖文件到页面任意位置）
            setupGlobalDragDrop();
        }

        // 全局拖拽覆盖层
        function setupGlobalDragDrop() {
            let dragOverlay = null;
            let dragCounter = 0;

            function createOverlay() {
                if (dragOverlay) return dragOverlay;
                dragOverlay = document.createElement('div');
                dragOverlay.id = 'globalDropOverlay';
                dragOverlay.style.cssText = `
                    position: fixed; inset: 0; z-index: 9999;
                    background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
                    display: flex; align-items: center; justify-content: center;
                    opacity: 0; transition: opacity 0.25s ease;
                    pointer-events: none;
                `;
                dragOverlay.innerHTML = `
                    <div style="text-align:center; color:#fff;">
                        <i class="fas fa-file-import" style="font-size:48px; opacity:0.7; margin-bottom:16px; display:block;"></i>
                        <div style="font-size:18px; font-weight:700; margin-bottom:6px;">释放以导入歌单</div>
                        <div style="font-size:13px; opacity:0.5;">支持 playlist.js 和 .json 文件</div>
                    </div>
                `;
                document.body.appendChild(dragOverlay);
                return dragOverlay;
            }

            document.addEventListener('dragenter', (e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                dragCounter++;
                const overlay = createOverlay();
                overlay.style.pointerEvents = 'auto';
                requestAnimationFrame(() => overlay.style.opacity = '1');
            });

            document.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
            });

            document.addEventListener('dragleave', (e) => {
                dragCounter--;
                if (dragCounter <= 0) {
                    dragCounter = 0;
                    if (dragOverlay) {
                        dragOverlay.style.opacity = '0';
                        dragOverlay.style.pointerEvents = 'none';
                    }
                }
            });

            document.addEventListener('drop', (e) => {
                dragCounter = 0;
                if (dragOverlay) {
                    dragOverlay.style.opacity = '0';
                    dragOverlay.style.pointerEvents = 'none';
                }

                const file = e.dataTransfer && e.dataTransfer.files[0];
                if (!file) return;

                // 如果拖到了设置模态框里的 dropZone，让那边的 handler 处理
                const settingsDropZone = document.getElementById('settingsDropZone');
                if (settingsDropZone && settingsDropZone.contains(e.target)) return;

                e.preventDefault();
                if (file.name.endsWith('.js') || file.name.endsWith('.json')) {
                    handleImportedFile(file);
                } else {
                    showToast('不支持的文件格式，请使用 .js 或 .json', true);
                }
            });
        }

        // ================= 欢迎引导模态框 =================
        function openWelcomeModal() {
            const modal = document.getElementById('welcomeModal');
            const card = document.getElementById('welcomeCard');
            if (!modal || !card) return;

            modal.classList.remove('hidden');
            delete modal.dataset.closing;
            void modal.offsetWidth;
            modal.classList.remove('opacity-0');
            card.classList.remove('scale-95');
            card.classList.add('scale-100');
            openAccessibleOverlay(modal, {
                close: closeWelcomeModal,
                initialFocus: '#welcomePlaylistInput'
            });
        }

        function closeWelcomeModal() {
            const modal = document.getElementById('welcomeModal');
            const card = document.getElementById('welcomeCard');
            if (!modal || !card) return;
            if (modal.dataset.closing === '1') return;
            modal.dataset.closing = '1';

            modal.classList.add('opacity-0');
            card.classList.add('scale-95');
            card.classList.remove('scale-100');
            setTimeout(() => {
                modal.classList.add('hidden');
                // Reset states
                const loading = document.getElementById('welcomeLoading');
                const error = document.getElementById('welcomeError');
                if (loading) loading.classList.add('hidden');
                if (error) error.classList.add('hidden');
                closeAccessibleOverlay(modal);
                delete modal.dataset.closing;
            }, 500);
        }

        async function submitWelcomePlaylist() {
            const input = document.getElementById('welcomePlaylistInput');
            const errorDiv = document.getElementById('welcomeError');
            const errorText = document.getElementById('welcomeErrorText');
            const loadingDiv = document.getElementById('welcomeLoading');
            const loadBtn = document.getElementById('welcomeLoadBtn');

            const rawId = input.value.trim();

            // 支持纯数字ID或从链接中提取ID
            const idMatch = rawId.match(/(\d{5,})/);
            if (!idMatch) {
                errorDiv.classList.remove('hidden');
                errorText.textContent = '请输入有效的歌单ID（纯数字，或包含歌单ID的链接）';
                input.classList.add('border-red-400/50');
                setTimeout(() => input.classList.remove('border-red-400/50'), 2000);
                return;
            }

            const playlistId = idMatch[1];
            errorDiv.classList.add('hidden');

            // Show loading
            loadingDiv.classList.remove('hidden');
            loadBtn.disabled = true;

            try {
                await loadPlaylistById(playlistId);

                // Success!
                document.getElementById('welcomeLoadingText').textContent = '加载成功！';
                document.getElementById('welcomeLoadingSubtext').textContent = `已加载 ${playlist.length} 首歌曲`;

                showToast(`🎵 歌单加载成功！共 ${playlist.length} 首歌曲`);

                setTimeout(() => {
                    closeWelcomeModal();
                }, 800);

            } catch (e) {
                // Failed
                loadingDiv.classList.add('hidden');
                loadBtn.disabled = false;
                errorDiv.classList.remove('hidden');
                errorText.textContent = '歌单加载失败，请检查ID是否正确或网络是否正常';
            }
        }

        // 欢迎模态框事件绑定（module script 执行时 DOM 已 ready，直接绑定）
        {
            const welcomeInput = document.getElementById('welcomePlaylistInput');
            const welcomeBtn = document.getElementById('welcomeLoadBtn');
            if (welcomeInput) {
                welcomeInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') submitWelcomePlaylist();
                });
            }
            if (welcomeBtn) {
                welcomeBtn.addEventListener('click', submitWelcomePlaylist);
            }
        }

        function initPlaylistView() {
            const countText = allSongsLoaded ? `(${playlist.length}首)` : `(${playlist.length}+首)`;
            document.getElementById('playlistCount').textContent = countText;

            // 打乱播放顺序（如果是随机模式）
            if (playMode === 'shuffle') {
                shufflePlaylist();
            }

            // 虚拟滚动渲染
            setupVirtualScroll();

            // 隐藏加载器
            document.getElementById('playlistLoader').classList.add('hidden');
        }

        // ================= 桌面端虚拟滚动 =================
        const VS_ITEM_H = 64;       // 每项高度 (px)，容纳 44px 键盘/触控操作
        const VS_BUFFER = 30;       // 上下各多渲染30项
        let vsDisplayOrder = [];     // 当前显示顺序
        let vsRenderedRange = { start: -1, end: -1 };  // 当前已渲染范围
        let vsScrollRAF = null;      // 防抖 requestAnimationFrame
        let vsNodeMap = new Map();   // displayIndex -> DOM node

        function getDisplayOrder() {
            if (playMode === 'shuffle' && shuffledOrder.length === playlist.length) {
                return shuffledOrder;
            }
            return playlist.map((_, i) => i);
        }

        function setupVirtualScroll() {
            vsDisplayOrder = getDisplayOrder();
            vsRenderedRange = { start: -1, end: -1 };
            vsNodeMap.clear();

            if (!playlist.length) {
                dom.playlistContent.innerHTML = '<div class="text-center py-8 opacity-50">播放列表为空</div>';
                dom.playlistContent.style.height = '';
                dom.playlistContent.style.position = '';
                return;
            }

            const totalHeight = vsDisplayOrder.length * VS_ITEM_H;
            dom.playlistContent.innerHTML = '';
            dom.playlistContent.style.height = totalHeight + 'px';
            dom.playlistContent.style.position = 'relative';

            vsRenderVisible(true);

            dom.playlistContainer.onscroll = () => {
                if (vsScrollRAF) return;
                vsScrollRAF = requestAnimationFrame(() => {
                    vsScrollRAF = null;
                    vsRenderVisible(false);
                });
            };
        }

        function vsCreateItem(i) {
            const actualIndex = vsDisplayOrder[i];
            const song = playlist[actualIndex];
            const songId = typeof song === 'object' ? song.id : song;
            const songName = typeof song === 'object' ? song.name : `歌曲 ID: ${song}`;
            const songArtist = typeof song === 'object' ? song.artist : '';
            const songCover = typeof song === 'object' ? song.cover : '';

            const div = document.createElement('div');
            div.className = 'playlist-item p-2 rounded-xl hover:bg-surface-container-high-color flex items-center gap-2 group theme-text-on-surface';
            div.dataset.idx = actualIndex;
            div.dataset.vsIdx = i;
            div.style.cssText = `position:absolute;top:${i * VS_ITEM_H}px;left:0;right:0;height:${VS_ITEM_H}px;`;

            if (actualIndex === currentIndex) {
                div.classList.add('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');
            }

            const numSpan = document.createElement('span');
            numSpan.className = 'song-index opacity-50 group-hover:opacity-100 font-mono text-xs w-6 text-right flex-shrink-0';
            numSpan.textContent = `${i + 1}`;

            const coverDiv = document.createElement('div');
            coverDiv.className = 'w-10 h-10 rounded-lg bg-surface-container-color flex-shrink-0 overflow-hidden';
            if (songCover) {
                const img = document.createElement('img');
                img.className = 'w-full h-full object-cover';
                img.loading = 'lazy';
                img.width = 40;
                img.height = 40;
                img.decoding = 'async';
                img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                window.getCachedImage(`${songCover}?param=80y80`).then(cachedSrc => {
                    if (img.isConnected) img.src = cachedSrc;
                });
                img.alt = songName;
                img.onerror = () => { img.style.display = 'none'; };
                coverDiv.appendChild(img);
            } else {
                coverDiv.innerHTML = '<i class="fas fa-music text-xs opacity-30 flex items-center justify-center w-full h-full"></i>';
            }

            const infoDiv = document.createElement('div');
            infoDiv.className = 'flex-1 min-w-0';
            const titleDiv = document.createElement('div');
            titleDiv.className = 'truncate text-sm font-medium';
            titleDiv.textContent = songName;
            const artistDiv = document.createElement('div');
            artistDiv.className = 'truncate text-xs opacity-50';
            artistDiv.textContent = songArtist || '未知艺术家';
            infoDiv.appendChild(titleDiv);
            infoDiv.appendChild(artistDiv);

            const playButton = document.createElement('button');
            playButton.type = 'button';
            playButton.className = 'flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg';
            playButton.setAttribute('aria-label', '播放「' + songName + '」');
            playButton.appendChild(numSpan);
            playButton.appendChild(coverDiv);
            playButton.appendChild(infoDiv);
            div.appendChild(playButton);

            playButton.onclick = () => {
                currentIndex = actualIndex;
                loadAndPlaySong(songId, { index: actualIndex, reason: 'playlist_click' });
            };
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'js-remove-queue w-11 h-11 flex-none flex items-center justify-center rounded-full border border-white/15 text-xs opacity-70';
            delBtn.setAttribute('aria-label', '从播放列表移除「' + songName + '」');
            delBtn.title = '从播放列表移除';
            delBtn.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
            delBtn.onclick = function (e) {
                e.stopPropagation();
                window.removeSongFromQueue(actualIndex);
            };
            div.appendChild(delBtn);
            return div;
        }

        function vsRenderVisible(forceRebuild) {
            const scrollTop = dom.playlistContainer.scrollTop;
            const viewHeight = dom.playlistContainer.clientHeight;
            const totalItems = vsDisplayOrder.length;

            let newStart = Math.floor(scrollTop / VS_ITEM_H) - VS_BUFFER;
            let newEnd = Math.ceil((scrollTop + viewHeight) / VS_ITEM_H) + VS_BUFFER;
            newStart = Math.max(0, newStart);
            newEnd = Math.min(totalItems, newEnd);

            const oldStart = vsRenderedRange.start;
            const oldEnd = vsRenderedRange.end;

            if (!forceRebuild && newStart === oldStart && newEnd === oldEnd) return;

            if (forceRebuild) {
                // 全量初始化
                dom.playlistContent.innerHTML = '';
                vsNodeMap.clear();
                const frag = document.createDocumentFragment();
                for (let i = newStart; i < newEnd; i++) {
                    const node = vsCreateItem(i);
                    vsNodeMap.set(i, node);
                    frag.appendChild(node);
                }
                dom.playlistContent.appendChild(frag);
            } else {
                // 增量：移除离开范围的节点
                for (let i = oldStart; i < oldEnd; i++) {
                    if (i < newStart || i >= newEnd) {
                        const node = vsNodeMap.get(i);
                        if (node && node.parentNode) node.parentNode.removeChild(node);
                        vsNodeMap.delete(i);
                    }
                }
                // 增量：添加新进入范围的节点
                const frag = document.createDocumentFragment();
                let added = false;
                for (let i = newStart; i < newEnd; i++) {
                    if (!vsNodeMap.has(i)) {
                        const node = vsCreateItem(i);
                        vsNodeMap.set(i, node);
                        frag.appendChild(node);
                        added = true;
                    }
                }
                if (added) dom.playlistContent.appendChild(frag);
            }

            vsRenderedRange = { start: newStart, end: newEnd };
        }

        // 一次性渲染播放列表（保留作为兼容入口，内部走虚拟滚动）
        function renderAllPlaylistItems() {
            setupVirtualScroll();
        }

        // 保留旧函数名以兼容
        function renderPlaylistChunk() {
            renderAllPlaylistItems();
        }

        // Expose functions globally for Mobile UI
        window.playSongAtIndex = (index, options) => {
            options = options || {};
            if (index < 0 || index >= playlist.length) return;
            const prefetchedMedia = options.prefetchedMedia || takePreloadedNextMedia(index);
            currentIndex = index;
            scheduleSaveCurrentQueue('play_index'); // Sync with global variable
            // currentSongIndex = index; // Removed if not defined

            const song = playlist[index];
            const songId = typeof song === 'object' ? song.id : song;

            loadAndPlaySong(songId, {
                index: index,
                reason: options.reason || 'play_index',
                resumeTime: options.useSavedResume === false ? 0 : getPlaybackResumeTime(index),
                prefetchedMedia
            });

            // Sync mobile playlist view if active
            if (mobileUI && mobileUI.activeSheetTab === 'playlist') {
                mobileUI.loadPlaylist();
            }
        };

        function highlightCurrentSong() {
            // 移除旧的高亮
            const old = dom.playlistContent.querySelector('.playing-item');
            if (old) old.classList.remove('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');

            // 添加新的高亮（如果当前歌曲在可见区域内）
            let el = dom.playlistContent.querySelector(`div[data-idx="${currentIndex}"]`);
            if (el) {
                el.classList.add('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');
            }

            // 滚动到当前歌曲在显示顺序中的位置
            const displayPos = vsDisplayOrder.indexOf(currentIndex);
            if (displayPos !== -1) {
                const targetTop = displayPos * VS_ITEM_H - dom.playlistContainer.clientHeight / 2 + VS_ITEM_H / 2;
                dom.playlistContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
            }
        }

        function playNextSong() {
            if (!playlist.length) return;
            const nextIndex = getNextSongIndex({ ignoreRepeatOne: true });
            if (nextIndex < 0) {
                if (typeof showToast === 'function') showToast('已到播放列表末尾');
                return;
            }
            currentIndex = nextIndex;
            scheduleSaveCurrentQueue('next');
            const song = playlist[currentIndex];
            const songId = typeof song === 'object' ? song.id : song;
            loadAndPlaySong(songId, { index: currentIndex, reason: 'next' });
        }

        function playPreviousSong() {
            if (!playlist.length) return;
            const previousIndex = getPreviousSongIndex({ ignoreRepeatOne: true });
            if (previousIndex < 0) {
                if (typeof showToast === 'function') showToast('已到播放列表开头');
                return;
            }
            currentIndex = previousIndex;
            scheduleSaveCurrentQueue('previous');
            const song = playlist[currentIndex];
            const songId = typeof song === 'object' ? song.id : song;
            loadAndPlaySong(songId, { index: currentIndex, reason: 'previous' });
        }

        function handleSongEnd() {
            clearPlaybackSession();
            if (!committedMedia || !committedMedia.ready || !isCommittedMediaCurrent()) {
                applyPausedPlaybackState(false);
                return;
            }
            if (activePlaybackAttempt && activePlaybackAttempt.token !== committedMedia.token) {
                applyPausedPlaybackState(false);
                return;
            }
            if (audio.ended !== true || committedMedia.endedHandled) return;
            committedMedia.endedHandled = true;
            const endedIndex = resolvePlaylistIndexBySongId(committedMedia.songId);
            if (endedIndex < 0) {
                applyPausedPlaybackState(false);
                return;
            }
            currentIndex = endedIndex;
            if (playMode === 'repeat_one') {
                audio.currentTime = 0;
                resumeCommittedMedia('repeat_one');
                return;
            }
            const nextIndex = getNextSongIndex({ ignoreRepeatOne: true });
            if (nextIndex < 0) {
                try { audio.pause(); } catch (error) {}
                applyPausedPlaybackState(false);
                return;
            }
            window.playSongAtIndex(nextIndex, { reason: 'ended', useSavedResume: false });
        }

        // Kept as a compatibility entry point for older inline integrations.
        function togglePlayMode() {
            cyclePlayMode();
        }

        // ================= 视觉与主题 =================
        function setupAudioContext() {
            // IMPORTANT for mobile background playback:
            // Do NOT call createMediaElementSource. Once routed into WebAudio,
            // many mobile browsers suspend AudioContext when backgrounded and mute sound.
            // Keep <audio> on the native output path only (same as sites that work in background).
            if (window.__audioGraphDisabledLogged) return;
            window.__audioGraphDisabledLogged = true;
            audioContext = null;
            analyser = null;
            gainNode = null;
            compressorNode = null;
            console.log('[audio] native <audio> path only (background-safe, no quality loss)');
        }

        // ================= 安全插入歌曲到播放列表 =================
        window.insertSongToPlaylist = function (newSong) {
            if (currentIndex === -1) currentIndex = playlist.length > 0 ? playlist.length - 1 : 0;

            if (playlist.length === 0) {
                playlist.push(newSong);
                window.playlist = playlist;
                if (playMode === 'shuffle') shuffledOrder = [0];
                scheduleSaveCurrentQueue('insert_empty');
                return 0;
            }

            const insertIndex = currentIndex + 1;
            playlist.splice(insertIndex, 0, newSong);
            window.playlist = playlist;

            if (playMode === 'shuffle') {
                for (let i = 0; i < shuffledOrder.length; i++) {
                    if (shuffledOrder[i] >= insertIndex) {
                        shuffledOrder[i]++;
                    }
                }
                let currentShufflePos = shuffledOrder.indexOf(currentIndex);
                if (currentShufflePos === -1) currentShufflePos = shuffledOrder.length - 1;
                shuffledOrder.splice(currentShufflePos + 1, 0, insertIndex);
            }

            scheduleSaveCurrentQueue('insert');
            return insertIndex;
        };
;

        function syncVisualLifecycle() {
            if (visualizerController) visualizerController.sync();
            if (fluidBg) fluidBg.setPlaying(isPlaying);
        }

        function prefersReducedMotion() {
            return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
        }

        function isMobileLayoutViewport() {
            return mobileLayoutQuery ? mobileLayoutQuery.matches : window.innerWidth < 768;
        }

        function setupReducedMotionPreference() {
            if (!reducedMotionQuery || reducedMotionListenerBound) return;
            const handleChange = function () { syncVisualLifecycle(); };
            if (typeof reducedMotionQuery.addEventListener === 'function') {
                reducedMotionQuery.addEventListener('change', handleChange);
            } else if (typeof reducedMotionQuery.addListener === 'function') {
                reducedMotionQuery.addListener(handleChange);
            }
            reducedMotionListenerBound = true;
        }

        function initVisualizer() {
            if (visualizerController) return visualizerController;
            const canvas = document.getElementById('audioVisualizer');
            const ctx = canvas.getContext('2d');

            if (!audioContext && isPlaying) setupAudioContext();

            function resize() {
                // 画布比封面大一些，用来画波形
                const coverSizePx = parseInt(getComputedStyle(dom.html).getPropertyValue('--cover-size'));
                const size = coverSizePx + 100; // 留足空间画波浪
                canvas.width = size;
                canvas.height = size;
            }
            window.addEventListener('resize', resize);
            resize();

            const bufferLength = analyser ? analyser.frequencyBinCount : 128;
            const dataArray = new Uint8Array(bufferLength);

            let animationFrameId = null;

            function shouldDraw() {
                return !!(analyser && isPlaying && !prefersReducedMotion() && document.visibilityState === 'visible');
            }

            function draw() {
                animationFrameId = null;
                if (!shouldDraw()) return;

                // 1. 实验性功能：背景激荡逻辑 (已移除 isGradientMode 依赖)
                // if (analyser && isPlaying && ++frameCount % 5 === 0) {
                // 移除旧的背景逻辑，避免报错
                // }

                // 2. 清空画布
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                // 3. Siri 环形波形绘制 (Experimental)
                analyser.getByteFrequencyData(dataArray);

                const centerX = canvas.width / 2;
                const centerY = canvas.height / 2;
                // 半径基于封面大小，确保紧贴边缘
                const coverRadius = (canvas.width - 100) / 2;
                const radius = coverRadius + 5; // 基础半径比封面稍大

                ctx.beginPath();

                // 获取主色调
                const primaryColor = getComputedStyle(dom.html).getPropertyValue('--primary-color').trim();
                ctx.strokeStyle = primaryColor;
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';

                const skipLow = Math.floor(bufferLength * 0.1);  // 跳过最低的10%频率
                const skipHigh = Math.floor(bufferLength * 0.1); // 跳过最高的10%频率
                const midStart = skipLow;
                const midEnd = bufferLength - skipHigh;
                const sliceLen = midEnd - midStart;
                const angleStep = (Math.PI * 2) / sliceLen;

                for (let i = 0; i < sliceLen; i++) {
                    const dataIndex = midStart + i; // 从中间频段开始取值
                    const value = dataArray[dataIndex];
                    // 动态计算波幅：中频区域更平滑
                    const amp = (value / 255) * 40;

                    const angle = i * angleStep - (Math.PI / 2); // 从顶部开始

                    // 计算外圈波形的坐标
                    // 使用正弦波平滑处理，避免锯齿
                    const r = radius + amp;

                    const x = centerX + Math.cos(angle) * r;
                    const y = centerY + Math.sin(angle) * r;

                    if (i === 0) {
                        ctx.moveTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                }

                // 闭合路径
                ctx.closePath();

                // 添加发光效果
                ctx.shadowBlur = 15;
                ctx.shadowColor = primaryColor;

                ctx.stroke();

                // 重置阴影，避免影响性能
                ctx.shadowBlur = 0;
                animationFrameId = requestAnimationFrame(draw);
            }

            visualizerController = {
                sync: function () {
                    if (shouldDraw()) {
                        if (animationFrameId === null) animationFrameId = requestAnimationFrame(draw);
                        return;
                    }
                    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
                    animationFrameId = null;
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                }
            };
            visualizerController.sync();
            return visualizerController;
        }

        // rgbToHsl - 保留供流体背景使用
        function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h, s, l = (max + min) / 2;
            if (max === min) h = s = 0;
            else {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                    case g: h = (b - r) / d + 2; break;
                    case b: h = (r - g) / d + 4; break;
                }
                h /= 6;
            }
            return { h: Math.round(h * 360), s, l };
        }

        function toggleFullScreen() {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => {
                    showToast(`无法启用全屏: ${err.message}`, true);
                });
                document.querySelector('#fullscreenBtn i').classList.replace('fa-expand', 'fa-compress');
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                    document.querySelector('#fullscreenBtn i').classList.replace('fa-compress', 'fa-expand');
                }
            }
        }




        // 沉浸模式状态
        let isImmersiveMode = false;

        function toggleImmersiveMode() {
            isImmersiveMode = !isImmersiveMode;
            const topSection = document.getElementById('topSectionArea');
            const btn = document.getElementById('immersiveModeBtn');
            const btnText = document.getElementById('immersiveModeText');
            const btnIcon = btn ? btn.querySelector('i') : null;

            if (topSection) {
                if (isImmersiveMode) {
                    topSection.classList.add('immersive-hidden');
                    if (btnText) btnText.textContent = '退出沉浸模式';
                    if (btnIcon) {
                        btnIcon.classList.remove('fa-eye');
                        btnIcon.classList.add('fa-eye-slash');
                    }
                    if (btn) btn.classList.add('bg-primary-color', 'text-on-primary-color');
                } else {
                    topSection.classList.remove('immersive-hidden');
                    if (btnText) btnText.textContent = '开启沉浸模式';
                    if (btnIcon) {
                        btnIcon.classList.remove('fa-eye-slash');
                        btnIcon.classList.add('fa-eye');
                    }
                    if (btn) btn.classList.remove('bg-primary-color', 'text-on-primary-color');
                }
            }

            // 保存状态
            writeLocalStorage('cp_immersiveMode', isImmersiveMode ? 'on' : 'off');
        }

        function initImmersiveMode() {
            // 绑定沉浸模式按钮事件
            const immersiveModeBtn = document.getElementById('immersiveModeBtn');
            if (immersiveModeBtn) {
                immersiveModeBtn.onclick = toggleImmersiveMode;
            }

            // 恢复保存的状态
            const savedMode = readLocalStorage('cp_immersiveMode');
            if (savedMode === 'on') {
                toggleImmersiveMode();
            }
        }

        function formatTime(s) {
            if (isNaN(s)) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${m}:${sec.toString().padStart(2, '0')}`;
        }
        function updateVolumeIcon(vol) {
            let icon = 'fa-volume-mute';
            if (vol > 0.5) icon = 'fa-volume-up';
            else if (vol > 0) icon = 'fa-volume-down';
            dom.volumeBtn.innerHTML = `<i id="volumeIcon" class="fas ${icon} text-xl"></i>`;
        }

        // ================= ★ WebGL 流体背景渲染器 (参考 aura-music 风格) =================
        // ================= ★ Mobile UI Manager (Updated) =================

        // Global Instance
        let mobileUI = null;

        // ================= ★ FluidBackground (复制 aura-music WebGL) =================

        // ================= ★ Canvas 歌词渲染器 (参考 aura-music 效果) =================

        // ★ 全局实例
        let fluidBg = null;
        let lyricsCanvas = null;

        // 初始化渲染器
        function initCanvasRenderers() {
            if (!fluidBg) {
                // Inject the two bindings the class used to read from module scope.
                fluidBg = new FluidBackground('fluidBg', { isPlaying, prefersReducedMotion });
            }
            if (!lyricsCanvas) {
                // Inject the media element the class used to read from module scope.
                lyricsCanvas = new LyricsCanvasRenderer('lyricsCanvas', { audio });
            }
            if (!mobileUI) {
                // State arrives as getters so every read is current; a snapshot
                // here would freeze the values the mobile list renders from.
                mobileUI = new MobileUIManager({
                    audio,
                    getCurrentIndex: () => currentIndex,
                    getPlayMode: () => playMode,
                    getShuffledOrder: () => shuffledOrder,
                    showToast,
                    formatTime,
                    renderAllPlaylistItems,
                    // Only published on window (js/app.js:8570), never as a local.
                    playSongAtIndex: (index, options) => window.playSongAtIndex(index, options),
                    cyclePlayMode,
                    isMobileLayoutViewport,
                    escapeHtml,
                    setAccessibleTabState,
                    renderSearchRecoveryState,
                    isOverlayInteractionTarget,
                    togglePlayPause,
                    playPreviousSong,
                    playNextSong,
                    handleProgressKeydown,
                    bindArrowTabNavigation,
                    cleanupSearchResultPager,
                    createSearchResultPager,
                    syncProgressAccessibility,
                    musicService,
                    // js/app.js defines no top-level updateProgress; passing
                    // undefined preserves the pre-existing failure at that call.
                    updateProgress: undefined
                });
                window.mobileUI = mobileUI;
            }
            syncVisualLifecycle();
        }

        // updateLyrics 更新由 Canvas 的 animate 循环自动处理

        // 当封面变化时更新背景颜色
        function updateBackgroundFromCover(coverUrl) {
            if (fluidBg && coverUrl) {
                fluidBg.extractColorsFromImage(coverUrl);
            }
        }
