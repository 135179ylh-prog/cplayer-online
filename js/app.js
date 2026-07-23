        import {
            API_REQUEST_RETRIES,
            API_REQUEST_TIMEOUT_MS,
            API_RETRY_DELAY_MS,
            PLAYBACK_SESSION_VERSION,
            clampMediaSeekTime,
            classifyPlaybackFailure,
            classifyPlaybackQuality,
            fetchJsonWithRetry,
            getSafePlaybackResumeTime,
            getSleepTimerRemainingMs,
            normalizePlaybackSession,
            normalizeSongObject
        } from './core-utils.js';
        import {
            CLOUD_MAX_PLAYLISTS,
            CPlayerCloudService,
            decidePlaylistSync,
            isSameCloudMutation,
            isCloudConflictError,
            makeCloudOutboxId,
            normalizeCloudConfig,
            projectCloudSyncStatus,
            toCloudPlaylistInput
        } from './cloud-sync.js';

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

            async search(query) {
                const url = ChKSzAPI.buildUrl('/163_search', { keyword: query, limit: 30 });
                try {
                    const json = await fetchJsonWithTimeout(url);
                    let items = [];
                    if (json.code === 200) {
                        if (Array.isArray(json.data)) items = json.data;
                        else if (json.data && Array.isArray(json.data.songs)) items = json.data.songs;
                        else if (json.result && Array.isArray(json.result.songs)) items = json.result.songs;
                    }
                    if (items.length > 0) {
                        return items.map(item => ({
                            id: item.id,
                            name: item.name,
                            artist: item.artists ? (Array.isArray(item.artists) ? item.artists.map(a => a.name).join(', ') : (typeof item.artists === 'string' ? item.artists : (item.artists.name || 'Unknown'))) : 'Unknown',
                            album: item.album ? (typeof item.album === 'string' ? item.album : item.album.name) : '',
                            cover: item.picUrl || (item.album ? item.album.picUrl : '') || '',
                            source: 'ChKSz'
                        }));
                    }
                } catch (e) {
                    console.error('Search API Error:', e);
                    throw e;
                }
                return [];
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
        let preloadedSongId = null;

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
        let visualizerController = null;
        const reducedMotionQuery = typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : null;
        const mobileLayoutQuery = typeof window.matchMedia === 'function'
            ? window.matchMedia('(max-width: 767px), (max-width: 900px) and (max-height: 500px) and (orientation: landscape)')
            : null;
        let reducedMotionListenerBound = false;

        // ================= IndexedDB 缓存系统 =================
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 5;
        const CLOUD_OUTBOX_STORE = 'cloud_outbox';
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
        let cloudPendingReadToken = 0;
        let cloudLastSuccessfulAt = 0;
        let cloudLastErrorMessage = '';
        const cloudConflicts = new Map();
        const CLOUD_DETACH_PENDING_KEY = 'cp_cloud_detach_pending';
        const CLOUD_LAST_SUCCESS_KEY = 'cp_cloud_last_success';

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
                ready: false
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

        function makeCloudOutboxRecord(ownerId, record, operation, expectedVersion) {
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
            if (operation === 'upsert') base.playlist = makeCloudPlaylistSnapshot(record);
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
                cloudPendingCount = records.length;
                refreshCloudAccountUI();
            } catch (error) {
                if (readToken !== cloudPendingReadToken) return;
                const sameOwner = requestedOwnerId ? cloudUserId === requestedOwnerId : !cloudUserId;
                if (sameOwner) {
                    setCloudState('error', '无法读取待同步项目，本机数据仍保留', error);
                }
            }
        }

        function setCloudPendingCount(value) {
            const count = Number(value);
            cloudPendingReadToken += 1;
            cloudPendingCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
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
                            cloudDirty: fields.cloudDirty
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

        async function saveUserPlaylistRecord(rec, options) {
            options = options || {};
            if (!db) throw new Error('数据库未就绪');
            const cloudFields = normalizeLocalCloudFields(rec || {});
            const ownerId = options.remote
                ? cloudFields.cloudOwnerId
                : (cloudFields.cloudOwnerId || cloudUserId || '');
            const cloudVersion = cloudFields.cloudVersion;
            const cloudDirty = options.remote ? false : !!ownerId;
            const payload = {
                id: rec.id,
                name: rec.name || '未命名歌单',
                songs: Array.isArray(rec.songs) ? rec.songs : [],
                timestamp: options.preserveTimestamp && Number.isFinite(Number(rec.timestamp))
                    ? Number(rec.timestamp)
                    : Date.now(),
                cloudOwnerId: ownerId,
                cloudVersion: cloudVersion,
                cloudDirty: cloudDirty
            };
            const outbox = !options.remote && ownerId
                ? makeCloudOutboxRecord(ownerId, payload, 'upsert', cloudVersion)
                : null;
            try {
                await runCriticalStorageWrite(async function () {
                    if (outbox && !hasCloudOutboxStore()) throw new Error('云同步存储未就绪');
                    const stores = outbox ? ['playlists', CLOUD_OUTBOX_STORE] : ['playlists'];
                    const tx = db.transaction(stores, 'readwrite');
                    tx.objectStore('playlists').put(payload);
                    if (outbox) tx.objectStore(CLOUD_OUTBOX_STORE).put(outbox);
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

            const existing = await listUserPlaylists();
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
            if (cloudUserId && (await listUserPlaylists()).length >= CLOUD_MAX_PLAYLISTS) {
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
                const tx = db.transaction(
                    hasCloudOutboxStore() ? ['playlists', CLOUD_OUTBOX_STORE] : ['playlists'],
                    'readwrite'
                );
                const playlistStore = tx.objectStore('playlists');
                const existingRequest = playlistStore.get(playlistId);
                let existing = null;
                existingRequest.onsuccess = function () {
                    existing = existingRequest.result || null;
                    playlistStore.delete(playlistId);
                    const fields = normalizeLocalCloudFields(existing || {});
                    if (fields.cloudOwnerId && hasCloudOutboxStore()) {
                        tx.objectStore(CLOUD_OUTBOX_STORE).put(
                            makeCloudOutboxRecord(fields.cloudOwnerId, { id: playlistId }, 'delete', fields.cloudVersion)
                        );
                    }
                };
                existingRequest.onerror = function () {
                    try { tx.abort(); } catch (abortError) {}
                };
                await transactionDone(tx);
                if (existing && normalizeLocalCloudFields(existing).cloudOwnerId) {
                    setCloudState('pending', '歌单删除已保存在本机，等待同步');
                    scheduleCloudSync('playlist_delete');
                }
            } catch (error) {
                setStorageState('degraded', STORAGE_WARNING, error);
                throw error;
            }
        }

        async function adoptLocalPlaylistsForCloud(ownerId) {
            if (!db || !ownerId || !hasCloudOutboxStore()) return 0;
            let adopted = 0;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            const store = tx.objectStore('playlists');
            const request = store.getAll();
            request.onsuccess = function () {
                (request.result || []).forEach(function (record) {
                    if (!record || typeof record.id !== 'string' ||
                        record.id.indexOf(USER_PL_PREFIX) !== 0) return;
                    const fields = normalizeLocalCloudFields(record);
                    if (fields.cloudOwnerId) return;
                    const next = Object.assign({}, record, {
                        cloudOwnerId: ownerId,
                        cloudVersion: 0,
                        cloudDirty: true
                    });
                    store.put(next);
                    tx.objectStore(CLOUD_OUTBOX_STORE).put(
                        makeCloudOutboxRecord(ownerId, next, 'upsert', 0)
                    );
                    adopted += 1;
                });
            };
            await transactionDone(tx);
            return adopted;
        }

        async function acknowledgeCloudUpsert(ownerId, sentOutbox, remote) {
            if (!db || !hasCloudOutboxStore() || !sentOutbox || !remote) return;
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
                const latestOutbox = currentRequest.result || null;
                const latestLocalRequest = nextPlaylistStore.get(sentOutbox.playlistId);
                latestLocalRequest.onsuccess = function () {
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
            if (!db || !hasCloudOutboxStore() || !remote) return;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const localRequest = playlistStore.get(remote.id);
            let collisionError = null;
            localRequest.onsuccess = function () {
                const local = localRequest.result || null;
                const localOwner = normalizeLocalCloudFields(local).cloudOwnerId;
                if (local && localOwner && localOwner !== ownerId) {
                    collisionError = makeCloudOwnerCollisionError();
                    return;
                }
                if (remote.deletedAt) {
                    playlistStore.delete(remote.id);
                    outboxStore.delete(makeCloudOutboxId(ownerId, remote.id));
                    return;
                }
                playlistStore.put({
                    id: remote.id,
                    name: remote.name,
                    songs: remote.songs,
                    timestamp: remote.updatedAt,
                    cloudOwnerId: ownerId,
                    cloudVersion: remote.version,
                    cloudDirty: false
                });
                outboxStore.delete(makeCloudOutboxId(ownerId, remote.id));
                if (local && typeof refreshMyPlaylists === 'function') {
                    setTimeout(function () { refreshMyPlaylists(); }, 0);
                }
            };
            await transactionDone(tx);
            if (collisionError) throw collisionError;
        }

        async function removeLocalCloudPlaylist(ownerId, playlistId) {
            if (!db || !hasCloudOutboxStore()) return;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const localRequest = playlistStore.get(playlistId);
            localRequest.onsuccess = function () {
                const local = localRequest.result || null;
                const localOwner = normalizeLocalCloudFields(local).cloudOwnerId;
                if (!local || localOwner === ownerId) {
                    playlistStore.delete(playlistId);
                }
                outboxStore.delete(makeCloudOutboxId(ownerId, playlistId));
            };
            await transactionDone(tx);
        }

        async function acknowledgeCloudDelete(ownerId, sentOutbox, remote) {
            if (!db || !hasCloudOutboxStore() || !sentOutbox || !remote) return;
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const outboxRequest = outboxStore.get(sentOutbox.id);
            outboxRequest.onsuccess = function () {
                const latest = outboxRequest.result || null;
                if (!latest || isSameCloudMutation(latest, sentOutbox)) {
                    const localRequest = playlistStore.get(sentOutbox.playlistId);
                    localRequest.onsuccess = function () {
                        const local = localRequest.result || null;
                        const localOwner = normalizeLocalCloudFields(local).cloudOwnerId;
                        if (!local || localOwner === ownerId) {
                            playlistStore.delete(sentOutbox.playlistId);
                        }
                        outboxStore.delete(sentOutbox.id);
                    };
                } else {
                    outboxStore.put(Object.assign({}, latest, { expectedVersion: remote.version }));
                }
            };
            await transactionDone(tx);
        }

        async function detachCloudOwner(ownerId) {
            if (!ownerId) throw new Error('缺少待清理的云账号');
            if (!db || !hasCloudOutboxStore()) throw new Error('本机数据库未就绪，无法清理云账号标记');
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            const playlistStore = tx.objectStore('playlists');
            const outboxStore = tx.objectStore(CLOUD_OUTBOX_STORE);
            const playlistRequest = playlistStore.getAll();
            const outboxRequest = outboxStore.indexNames.contains('ownerId')
                ? outboxStore.index('ownerId').getAll(IDBKeyRange.only(ownerId))
                : outboxStore.getAll();
            playlistRequest.onsuccess = function () {
                (playlistRequest.result || []).forEach(function (record) {
                    if (normalizeLocalCloudFields(record).cloudOwnerId !== ownerId) return;
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
                '#userPlaylistModal, #myPlaylistsModal, #playlistDetailModal, #settingsModal, #welcomeModal'
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
            activeLibraryTab = tab === 'recent' ? 'recent' : 'playlists';
            const isPlaylists = activeLibraryTab === 'playlists';
            const playlistTab = document.getElementById('libraryPlaylistsTab');
            const recentTab = document.getElementById('libraryRecentTab');
            const playlistPanel = document.getElementById('libraryPlaylistsPanel');
            const recentPanel = document.getElementById('libraryRecentPanel');
            if (playlistPanel) playlistPanel.classList.toggle('hidden', !isPlaylists);
            if (recentPanel) recentPanel.classList.toggle('hidden', isPlaylists);
            setAccessibleTabState(playlistTab, playlistPanel, isPlaylists);
            setAccessibleTabState(recentTab, recentPanel, !isPlaylists);
            if (isPlaylists) refreshMyPlaylists();
            else refreshRecentHistory();
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
            if (closeButton) closeButton.addEventListener('click', closePlaylistDetail);
            if (playButton) playButton.addEventListener('click', playCurrentDetailPlaylist);
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
            bindArrowTabNavigation(libraryTabList, [libraryPlaylistsTab, libraryRecentTab], function (tab) {
                switchLibraryTab(tab === libraryRecentTab ? 'recent' : 'playlists');
            });
            bindPlaylistDetailUI();
            refreshMyPlaylists();
            refreshRecentHistory();
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
        function preloadNextSong() {
            if (!playlist.length) return;

            const nextIndex = getNextSongIndex();
            if (nextIndex < 0) return;
            const nextSong = playlist[nextIndex];
            const nextSongId = typeof nextSong === 'object' ? nextSong.id : nextSong;

            // 避免重复预加载
            if (preloadedSongId === nextSongId) return;

            // 异步获取下一首歌曲的 URL
            musicService.getSong(nextSongId).then(data => {
                if (data?.url) {
                    preloadAudio.src = data.url;
                    preloadAudio.load();
                    preloadedSongId = nextSongId;
                    console.log('🎵 预加载下一首:', nextSong.name || nextSongId);
                }
            }).catch(() => { });
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

        // ================= 弹簧物理滚动 =================
        let springState = {
            animating: false,
            current: 0,
            target: 0,
            velocity: 0
        };

        // 弹簧参数（参考 aura-music）
        const SPRING_CONFIG = {
            stiffness: 80,    // 更软的弹簧
            damping: 20,      // 适当阻尼
            mass: 1           // 质量
        };

        function springScrollTo(container, targetY) {
            springState.target = targetY;
            springState.current = container.scrollTop;

            if (springState.animating) return;
            springState.animating = true;
            springState.velocity = 0;

            function animate() {
                const { stiffness, damping, mass } = SPRING_CONFIG;

                // 弹簧力 = -k * x
                const displacement = springState.current - springState.target;
                const springForce = -stiffness * displacement;

                // 阻尼力 = -c * v
                const dampingForce = -damping * springState.velocity;

                // 加速度 = F / m
                const acceleration = (springForce + dampingForce) / mass;

                // 更新速度和位置（使用固定时间步长 16ms）
                springState.velocity += acceleration * 0.016;
                springState.current += springState.velocity * 0.016;

                // 应用滚动
                container.scrollTop = springState.current;

                // 判断是否停止（速度和位移都足够小）
                const isSettled = Math.abs(springState.velocity) < 0.5 && Math.abs(displacement) < 0.5;

                if (isSettled) {
                    container.scrollTop = springState.target;
                    springState.animating = false;
                } else {
                    requestAnimationFrame(animate);
                }
            }

            requestAnimationFrame(animate);
        }

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
            storageWarningUiReady = true;
            flushStorageWarning();

            // ★ 初始化 IndexedDB 缓存
            try {
                await initDatabase();
                console.log('💾 IndexedDB 缓存已初始化');
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

            const notifyOffline = () => showToast('已离线，已保存的歌单和最近播放仍可使用', true);
            const notifyOnline = () => {
                showToast('网络已恢复');
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

        function rememberCloudSyncSuccess(ownerId) {
            if (!ownerId || cloudUserId !== ownerId) return;
            cloudLastSuccessfulAt = Date.now();
            writeLocalStorage(CLOUD_LAST_SUCCESS_KEY, JSON.stringify({
                ownerId,
                at: cloudLastSuccessfulAt
            }));
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
            cloudState = nextState;
            if (message) cloudStateMessage = message;
            if (nextState === 'error') cloudLastErrorMessage = message || '云同步操作失败';
            else if (nextState === 'synced' || nextState === 'signed-out' || nextState === 'disabled') {
                cloudLastErrorMessage = '';
            }
            document.documentElement.dataset.cplayerCloudState = nextState;
            if (error) console.warn('[cloud]', message || nextState, error);
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
            const allButtons = card.querySelectorAll('button');

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
        }

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
                cloudLastErrorMessage = '';
            }
            cloudLastSuccessfulAt = cloudUserId ? readCloudLastSuccessfulAt(cloudUserId) : 0;
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
            const outbox = makeCloudOutboxRecord(
                ownerId,
                operation === 'delete' ? { id: localRecord.id } : localRecord,
                operation,
                expectedVersion
            );
            const tx = db.transaction(['playlists', CLOUD_OUTBOX_STORE], 'readwrite');
            if (operation === 'upsert') {
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
                setCloudState('conflict', '发现歌单冲突，请在设置中选择保留哪一份');
            }
        }

        async function latestRemotePlaylist(playlistId) {
            const rows = await cloudService.listPlaylists();
            return rows.find(function (row) { return row.id === playlistId; }) || null;
        }

        async function performCloudSync(reason) {
            const ownerId = cloudUserId;
            if (!cloudService || !ownerId) return false;
            if (navigator.onLine === false) {
                setCloudState('pending', '歌单已保存在本机，联网后同步');
                void refreshCloudPendingCount(ownerId);
                return false;
            }
            setCloudState('syncing', '正在同步歌单…');
            await adoptLocalPlaylistsForCloud(ownerId);
            const results = await Promise.all([
                readUserPlaylistRecords({ includeForeign: true, ownerId: ownerId }),
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
            const detectedConflicts = new Map();
            let changed = 0;

            for (const playlistId of playlistIds) {
                if (cloudUserId !== ownerId) return false;
                const local = localMap.get(playlistId) || null;
                const remote = remoteMap.get(playlistId) || null;
                let outbox = outboxMap.get(playlistId) || null;
                const decision = decidePlaylistSync(local, remote, outbox);
                try {
                    if (decision.action === 'none') continue;
                    if (decision.action === 'pull' || decision.action === 'pull-delete') {
                        await applyRemotePlaylistToLocal(ownerId, remote);
                        changed += 1;
                        continue;
                    }
                    if (decision.action === 'ack-delete') {
                        await removeLocalCloudPlaylist(ownerId, playlistId);
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
                            decision.expectedVersion
                        );
                        await acknowledgeCloudUpsert(ownerId, outbox, acknowledged);
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
                            playlistId,
                            decision.expectedVersion
                        );
                        await acknowledgeCloudDelete(ownerId, outbox, acknowledged);
                        changed += 1;
                    }
                } catch (error) {
                    if (isCloudConflictError(error)) {
                        const latest = await latestRemotePlaylist(playlistId);
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

            for (const [playlistId, conflict] of cloudConflicts) {
                if (conflict && conflict.ownerId === ownerId) cloudConflicts.delete(playlistId);
            }
            for (const [playlistId, conflict] of detectedConflicts) {
                cloudConflicts.set(playlistId, conflict);
            }
            const remaining = await readCloudOutbox(ownerId);
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

        async function syncCloudPlaylists(reason) {
            if (!cloudService || !cloudUserId) {
                setCloudState(cloudService ? 'signed-out' : 'disabled',
                    cloudService ? '请先登录再同步' : '云同步尚未配置，播放器仍可本地使用');
                return false;
            }
            if (cloudSyncInFlight) {
                cloudSyncPendingReason = reason || 'queued';
                return cloudSyncInFlight;
            }
            const running = performCloudSync(reason || 'manual');
            cloudSyncInFlight = running;
            try {
                return await running;
            } catch (error) {
                const message = cloudErrorMessage(error, '同步失败，修改已保存在本机');
                setCloudState('error', message, error);
                void refreshCloudPendingCount(cloudUserId);
                if (reason === 'manual') showToast(message, true);
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

        async function resolveCloudConflict(useLocal) {
            const conflict = cloudConflicts.values().next().value || null;
            if (!conflict || conflict.ownerId !== cloudUserId || !cloudService) return;
            setCloudAccountBusy(true);
            try {
                if (useLocal) {
                    const remoteVersion = conflict.remote ? conflict.remote.version : 0;
                    let outbox = conflict.outbox;
                    if (outbox && outbox.operation === 'delete') {
                        const acknowledged = await cloudService.deletePlaylist(conflict.playlistId, remoteVersion);
                        await acknowledgeCloudDelete(conflict.ownerId, outbox, acknowledged);
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
                            remoteVersion
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
            bind('cloudAccountUseLocalBtn', function () { return resolveCloudConflict(true); });
            bind('cloudAccountUseCloudBtn', function () { return resolveCloudConflict(false); });
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
                    console.info('[playback] waiting for user gesture', error);
                    if (typeof showToast === 'function') showToast('浏览器阻止了自动播放，请点击播放按钮');
                    return 'blocked';
                }
                if (error && error.name === 'AbortError') {
                    if (audio.paused) applyPausedPlaybackState(false);
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
                    if (typeof showToast === 'function') showToast('浏览器阻止了自动播放，请再次点击播放');
                    return false;
                }
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

        let desktopSearchRequestId = 0;

        function renderSearchRecoveryState(container, options) {
            if (!container) return;
            options = options || {};
            const query = String(options.query || '').trim();
            const compact = options.compact === true;
            let message = navigator.onLine === false ? '当前已离线' : '搜索服务暂不可用';
            if (navigator.onLine !== false && options.error) {
                const failure = classifyPlaybackFailure(options.error, true);
                if (failure.kind === 'auth') message = failure.message;
            }
            const state = document.createElement('div');
            state.className = compact
                ? 'p-4 text-center opacity-80 text-xs'
                : 'p-4 text-center text-red-300';
            state.setAttribute('role', 'status');
            state.setAttribute('aria-live', 'polite');

            const messageNode = document.createElement('div');
            messageNode.textContent = message;
            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = compact
                ? 'mt-3 px-3 py-1.5 rounded-full border border-white/25 text-white/90'
                : 'mt-3 px-4 py-2 rounded-full border border-white/25 text-sm text-white/90 hover:bg-white/10';
            retryButton.setAttribute('aria-label', '重试搜索：' + query);
            retryButton.innerHTML = '<i class="fas fa-redo-alt mr-1" aria-hidden="true"></i><span>重试</span>';
            retryButton.addEventListener('click', function () {
                if (typeof options.onRetry === 'function') options.onRetry(query);
            });

            state.append(messageNode, retryButton);
            container.replaceChildren(state);
        }

        async function searchSongs(query) {
            query = String(query || '').trim();
            const requestId = ++desktopSearchRequestId;
            if (!query) {
                dom.searchResults.innerHTML = '';
                dom.searchResults.classList.add('hidden');
                return;
            }

            if (/^\d+$/.test(query)) {
                dom.searchResults.innerHTML = Array.from({ length: 1 }).map(() => `
                    <div class="playlist-item p-2 rounded-xl flex items-center gap-3 animate-pulse opacity-50 mb-1">
                        <div class="w-10 h-10 rounded-lg bg-white/10 flex-shrink-0 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                        <div class="flex-1 min-w-0 space-y-2 py-1">
                            <div class="h-4 bg-white/10 rounded w-1/3 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                            <div class="h-3 bg-white/10 rounded w-1/4 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                        </div>
                    </div>
                `).join('');
                dom.searchResults.classList.remove('hidden');

                try {
                    const songData = await musicService.getSong(query);
                    if (requestId !== desktopSearchRequestId) return;
                    if (songData && songData.url) {
                        const newSong = {
                            id: songData.id,
                            name: songData.name,
                            artist: songData.artist,
                            cover: songData.cover,
                            album: songData.album || '',
                            source: 'id_search'
                        };

                        // 插入到当前播放位置之后
                        const targetIndex = window.insertSongToPlaylist(newSong);
                        renderAllPlaylistItems();
                        playSongAtIndex(targetIndex);

                        dom.searchResults.classList.add('hidden');
                        dom.searchInput.value = '';
                        showToast(`已添加并播放: ${newSong.name}`);
                    } else {
                        throw new Error('无效的歌曲ID');
                    }
                } catch (e) {
                    if (requestId !== desktopSearchRequestId) return;
                    console.error(e);
                    const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
                    if (failure.kind === 'auth') {
                        renderSearchRecoveryState(dom.searchResults, {
                            query: query,
                            error: e,
                            onRetry: function (retryQuery) { searchSongs(retryQuery); }
                        });
                    } else {
                        dom.searchResults.innerHTML = '<div class="p-4 text-center text-red-400">无效ID或加载失败</div>';
                    }
                }
                return;
            }

            // dom.searchLoader.style.display = 'block';
            dom.searchResults.innerHTML = Array.from({ length: 10 }).map(() => `
                <div class="playlist-item p-2 rounded-xl flex items-center gap-3 animate-pulse opacity-50 mb-1">
                    <div class="w-10 h-10 rounded-lg bg-white/10 flex-shrink-0 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                    <div class="flex-1 min-w-0 space-y-2 py-1">
                        <div class="h-4 bg-white/10 rounded w-3/4 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                        <div class="h-3 bg-white/10 rounded w-1/2 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                    </div>
                </div>
            `).join('');
            dom.searchResults.classList.remove('hidden');

            try {
                const songs = await musicService.search(query);
                if (requestId !== desktopSearchRequestId) return;

                // [需求4] 限制显示30条结果
                const limitedSongs = songs ? songs.slice(0, 30) : [];

                if (limitedSongs.length) {
                    dom.searchResults.innerHTML = '';
                    limitedSongs.forEach(song => {
                        const div = document.createElement('div');
                        div.className = 'playlist-item p-2 rounded-xl hover:bg-surface-container-high-color flex items-center gap-2 transition-all theme-text-on-surface mb-1';

                        const coverDiv = document.createElement('span');
                        coverDiv.className = 'w-10 h-10 rounded-lg bg-surface-container-color flex-shrink-0 overflow-hidden';
                        if (song.cover) {
                            const img = document.createElement('img');
                            img.className = 'w-full h-full object-cover';
                            img.loading = 'lazy';
                            img.width = 40;
                            img.height = 40;
                            img.decoding = 'async';
                            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                            window.getCachedImage(`${song.cover}?param=80y80`).then(cachedSrc => {
                                if (img.isConnected) img.src = cachedSrc;
                            });
                            img.alt = song.name;
                            img.onerror = () => { img.style.display = 'none'; };
                            coverDiv.appendChild(img);
                        } else {
                            coverDiv.innerHTML = '<i class="fas fa-music text-xs opacity-30 flex items-center justify-center w-full h-full"></i>';
                        }

                        const infoDiv = document.createElement('span');
                        infoDiv.className = 'flex-1 min-w-0';
                        const titleDiv = document.createElement('span');
                        titleDiv.className = 'block truncate text-sm font-medium';
                        titleDiv.textContent = song.name || '未知歌曲';
                        const artistDiv = document.createElement('span');
                        artistDiv.className = 'block truncate text-xs opacity-50';
                        artistDiv.textContent = song.artist || '未知艺术家';

                        infoDiv.appendChild(titleDiv);
                        infoDiv.appendChild(artistDiv);

                        const playButton = document.createElement('button');
                        playButton.type = 'button';
                        playButton.className = 'flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg';
                        playButton.setAttribute('aria-label', '添加并播放「' + (song.name || '未知歌曲') + '」');
                        playButton.appendChild(coverDiv);
                        playButton.appendChild(infoDiv);
                        div.appendChild(playButton);

                        const actions = document.createElement('div');
                        actions.className = 'flex items-center gap-1 flex-shrink-0';
                        const addBtn = document.createElement('button');
                        addBtn.type = 'button';
                        addBtn.className = 'js-add-queue px-3 h-11 rounded-full border border-white/30 text-xs whitespace-nowrap';
                        addBtn.textContent = '加入播放列表';
                        addBtn.title = '加入播放列表（不立即播放）';
                        addBtn.setAttribute('aria-label', '加入播放列表（不立即播放）');
                        const plBtn = document.createElement('button');
                        plBtn.type = 'button';
                        plBtn.className = 'js-add-playlist px-3 h-11 rounded-full border border-white/30 text-xs whitespace-nowrap';
                        plBtn.textContent = '收藏到歌单';
                        plBtn.title = '收藏到歌单';
                        plBtn.setAttribute('aria-label', '收藏到歌单');
                        actions.appendChild(addBtn);
                        actions.appendChild(plBtn);
                        div.appendChild(actions);
                        const newSong = {
                            id: song.id, name: song.name, artist: song.artist,
                            cover: song.cover, album: song.album || '', source: song.source || 'Search'
                        };
                        try {
                            const payload = JSON.stringify(newSong);
                            addBtn.dataset.song = payload;
                            plBtn.dataset.song = payload;
                        } catch (e) {}
                        addBtn.onclick = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.addSongToQueueOnly(newSong);
                            // keep search results visible; just refresh playlist counters
                            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                        };
                        plBtn.onclick = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.openAddToPlaylistModal(newSong);
                        };
                        playButton.onclick = function () {
                            const targetIndex = window.insertSongToPlaylist(newSong);
                            renderAllPlaylistItems();
                            playSongAtIndex(targetIndex);
                            dom.searchResults.classList.add('hidden');
                            dom.searchInput.value = '';
                            showToast('已添加并播放: ' + newSong.name);
                        };
                        dom.searchResults.appendChild(div);
                    });
                } else {
                    dom.searchResults.innerHTML = '<div class="p-4 text-center opacity-60">未找到相关歌曲</div>';
                }
            } catch (error) {
                if (requestId !== desktopSearchRequestId) return;
                console.error(error);
                renderSearchRecoveryState(dom.searchResults, {
                    query: query,
                    error: error,
                    onRetry: function (retryQuery) {
                        if (dom.searchInput) dom.searchInput.value = retryQuery;
                        searchSongs(retryQuery);
                    }
                });
            } finally {
                // 搜索loader已移除
            }
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
            preloadedSongId = null;
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
                const data = await musicService.getSong(id);
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
                    setTimeout(function () {
                        if (activePlaybackAttempt && activePlaybackAttempt.token === token) preloadNextSong();
                    }, 2000);
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
            currentIndex = index;
            scheduleSaveCurrentQueue('play_index'); // Sync with global variable
            // currentSongIndex = index; // Removed if not defined

            const song = playlist[index];
            const songId = typeof song === 'object' ? song.id : song;

            loadAndPlaySong(songId, {
                index: index,
                reason: options.reason || 'play_index',
                resumeTime: options.useSavedResume === false ? 0 : getPlaybackResumeTime(index)
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
            window.playSongAtIndex(nextIndex);
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
        class MobileUIManager {
            constructor() {
                this.isMobile = isMobileLayoutViewport();
                this.currentMode = 'cover';
                this.activeSheetTab = 'playlist'; // playlist | search
                this.searchRequestId = 0;

                this.dom = {
                    mobileLayout: document.getElementById('mobileLayout'),
                    // Main Views
                    mobileCoverContainer: document.getElementById('mobileCoverContainer'),
                    mobileLyricsContainer: document.getElementById('mobileLyricsPage'),

                    // Sheet
                    sheet: document.getElementById('mobilePlaylistSheet'),
                    sheetToggleBtn: document.getElementById('mobilePlaylistToggleBtn'),
                    closeSheetBtn: document.getElementById('closeSheetBtn'),

                    // Sheet Tabs
                    tabPlaylist: document.getElementById('sheetTabPlaylist'),
                    tabSearch: document.getElementById('sheetTabSearch'),

                    // Sheet Content
                    contentPlaylist: document.getElementById('sheetContentPlaylist'),
                    contentSearch: document.getElementById('sheetContentSearch'),
                    playlistContainer: document.getElementById('mobilePlaylistContainer'),
                    searchResults: document.getElementById('mobileSearchResults'),
                    searchInput: document.getElementById('mobileSearchInput'),

                    // Elements
                    vinyl: document.getElementById('mobileAlbumArtWrapper'),
                    vinylContainer: document.getElementById('mobileVinylContainer'),
                    coverImg: document.getElementById('mobileCoverImg'),
                    title: document.getElementById('mobileTitle'),
                    artist: document.getElementById('mobileArtist'),
                    // Metadata
                    sourceTag: document.getElementById('mobileSourceTag'),
                    songIdTag: document.getElementById('mobileSongIdTag'),
                    qualityBadge: document.getElementById('mobileQualityBadge'),

                    // Controls
                    playBtn: document.getElementById('mobilePlayBtn'),
                    viewToggle: document.getElementById('mobileViewToggle'),
                    progressBar: document.getElementById('mobileProgressBar'),
                    progressContainer: document.getElementById('mobileProgressBarContainer'),
                    currentTime: document.getElementById('mobileCurrentTime'),
                    duration: document.getElementById('mobileDuration'),
                    prevBtn: document.getElementById('mobilePrevBtn'),
                    nextBtn: document.getElementById('mobileNextBtn'),
                    modeBtn: document.getElementById('mobileModeBtn')
                };

                this.init();
            }

            init() {
                this.bindEvents();
                this.bindSheetEvents();
                this.switchSheetTab(this.activeSheetTab);
                // 延迟执行 initial resize 以确保 DOM就绪
                requestAnimationFrame(() => this.handleResize());
                window.addEventListener('resize', () => this.handleResize());

                        this.loadPlaylist();
                        setTimeout(() => {
                            const activeItem = document.getElementById('mobile-playing-item');
                    if (activeItem) activeItem.scrollIntoView({ block: 'center', behavior: 'auto' });
                        }, 500);
            }

            bindEvents() {
                this.dom.viewToggle?.addEventListener('click', () => this.toggleView());

                // Swipe Logic
                let touchStartX = 0;
                let touchEndX = 0;

                const handleSwipe = () => {
                    const SWIPE_THRESHOLD = 50;
                    if (touchEndX < touchStartX - SWIPE_THRESHOLD) {
                        // Swipe Left -> Show Lyrics
                        if (this.currentMode === 'cover') this.toggleView();
                    }
                    if (touchEndX > touchStartX + SWIPE_THRESHOLD) {
                        // Swipe Right -> Show Cover
                        if (this.currentMode === 'lyrics') this.toggleView();
                    }
                };

                const mainView = document.getElementById('mobileMainView');
                mainView?.addEventListener('touchstart', (e) => {
                    touchStartX = e.changedTouches[0].screenX;
                }, { passive: true });
                mainView?.addEventListener('touchend', (e) => {
                    touchEndX = e.changedTouches[0].screenX;
                    handleSwipe();
                });

                // Click Vinyl to Toggle View (ONLY if sheet is closed)
                this.dom.vinylContainer?.addEventListener('click', (e) => {
                    e.stopPropagation(); // Prevent bubbling
                    if (!this.dom.sheet.classList.contains('translate-y-0')) {
                        this.toggleView();
                    } else {
                        // If sheet is open, close it (handled by document click, but just in case)
                        this.closeSheet();
                    }
                });

                // Global Click to Close Sheet
                document.addEventListener('click', (e) => {
                    const sheet = this.dom.sheet;
                    const toggleBtn = this.dom.sheetToggleBtn;

                    // If sheet is open (translate-y-0)
                    if (sheet.classList.contains('translate-y-0')) {
                        // If click is OUTSIDE sheet and NOT on toggle button
                        if (!sheet.contains(e.target) && (!toggleBtn || !toggleBtn.contains(e.target)) &&
                            !isOverlayInteractionTarget(e.target)) {
                            this.closeSheet();
                        }
                    }
                });

                // Sync Controls
                this.dom.playBtn?.addEventListener('click', togglePlayPause);
                this.dom.prevBtn?.addEventListener('click', playPreviousSong);
                this.dom.nextBtn?.addEventListener('click', playNextSong);
                this.dom.modeBtn?.addEventListener('click', cyclePlayMode);

                // Progress
                this.dom.progressContainer?.addEventListener('click', (e) => {
                    const rect = this.dom.progressContainer.getBoundingClientRect();
                    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    if (audio.duration) {
                        audio.currentTime = percent * audio.duration;
                        updateProgress();
                    }
                });
                this.dom.progressContainer?.addEventListener('keydown', handleProgressKeydown);
            }

            bindSheetEvents() {
                // Toggle Sheet
                this.dom.sheetToggleBtn?.addEventListener('click', () => this.openSheet());
                this.dom.closeSheetBtn?.addEventListener('click', () => this.closeSheet(true));

                // Switch Tabs
                this.dom.tabPlaylist?.addEventListener('click', () => this.switchSheetTab('playlist'));
                this.dom.tabSearch?.addEventListener('click', () => this.switchSheetTab('search'));
                bindArrowTabNavigation(this.dom.tabPlaylist && this.dom.tabPlaylist.parentElement,
                    [this.dom.tabPlaylist, this.dom.tabSearch], (tab) => {
                        this.switchSheetTab(tab === this.dom.tabSearch ? 'search' : 'playlist');
                    });

                // Search Input
                this.dom.searchInput?.addEventListener('change', (e) => {
                    this.handleSearch(e.target.value);
                });
                this.dom.searchInput?.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.handleSearch(e.target.value);
                });

                // ★ 拖拽关闭手势
                this.bindSheetDrag();
            }

            bindSheetDrag() {
                const sheet = this.dom.sheet;
                const handle = document.getElementById('sheetDragHandle');
                if (!sheet || !handle) return;

                let startY = 0;
                let currentTranslateY = 0;
                let isDragging = false;

                const onTouchStart = (e) => {
                    isDragging = true;
                    startY = e.touches[0].clientY;
                    currentTranslateY = 0;
                    sheet.style.transition = 'none'; // 拖拽时禁用过渡
                };

                const onTouchMove = (e) => {
                    if (!isDragging) return;
                    const deltaY = e.touches[0].clientY - startY;
                    if (deltaY > 0) { // 只允许下拉
                        currentTranslateY = deltaY;
                        sheet.style.transform = `translateY(${deltaY}px)`;
                    }
                };

                const onTouchEnd = () => {
                    if (!isDragging) return;
                    isDragging = false;
                    sheet.style.transition = ''; // 恢复过渡
                    sheet.style.transform = ''; // 清除内联 transform

                    const THRESHOLD = 100; // 下拉超过100px则关闭
                    if (currentTranslateY > THRESHOLD) {
                        this.closeSheet();
                    } else {
                        // 弹回
                        this.openSheet();
                    }
                    currentTranslateY = 0;
                };

                // 在手柄和整个 sheet 顶部区域监听
                handle.addEventListener('touchstart', onTouchStart, { passive: true });
                handle.addEventListener('touchmove', onTouchMove, { passive: true });
                handle.addEventListener('touchend', onTouchEnd);

                // 也允许从 sheet 头部拖拽
                const tabArea = sheet.querySelector('.flex-none');
                if (tabArea) {
                    tabArea.addEventListener('touchstart', onTouchStart, { passive: true });
                    tabArea.addEventListener('touchmove', onTouchMove, { passive: true });
                    tabArea.addEventListener('touchend', onTouchEnd);
                }
            }

            // Sheet Logic
            openSheet() {
                // ★ Fix: 打开前刷新播放列表，确保显示最新状态
                this.loadPlaylist();
                this.dom.sheet.classList.remove('translate-y-[110%]');
                this.dom.sheet.classList.add('translate-y-0');
                this.dom.sheet.inert = false;
                this.dom.sheet.setAttribute('aria-hidden', 'false');
                this.dom.sheetToggleBtn?.setAttribute('aria-expanded', 'true');
                const activeTab = this.activeSheetTab === 'search' ? this.dom.tabSearch : this.dom.tabPlaylist;
                requestAnimationFrame(() => activeTab?.focus());
            }

            closeSheet(restoreFocus) {
                const focusWasInside = this.dom.sheet.contains(document.activeElement);
                this.dom.sheet.style.transform = ''; // 清除拖拽残留
                this.dom.sheet.classList.remove('translate-y-0');
                this.dom.sheet.classList.add('translate-y-[110%]');
                this.dom.sheet.setAttribute('aria-hidden', 'true');
                this.dom.sheet.inert = true;
                this.dom.sheetToggleBtn?.setAttribute('aria-expanded', 'false');
                if ((restoreFocus || focusWasInside) && this.dom.sheetToggleBtn) {
                    requestAnimationFrame(() => this.dom.sheetToggleBtn.focus());
                }
            }

            switchSheetTab(tab) {
                this.activeSheetTab = tab;
                const isPlaylist = tab === 'playlist';

                // Update Tab Styles
                this.dom.tabPlaylist.classList.toggle('opacity-100', isPlaylist);
                this.dom.tabPlaylist.classList.toggle('opacity-50', !isPlaylist);
                this.dom.tabPlaylist.classList.toggle('border-primary-color', isPlaylist);
                this.dom.tabPlaylist.classList.toggle('border-transparent', !isPlaylist);

                this.dom.tabSearch.classList.toggle('opacity-100', !isPlaylist);
                this.dom.tabSearch.classList.toggle('opacity-50', isPlaylist);
                this.dom.tabSearch.classList.toggle('border-primary-color', !isPlaylist);
                this.dom.tabSearch.classList.toggle('border-transparent', isPlaylist);

                // Update Content Visibility
                this.dom.contentPlaylist.classList.toggle('hidden', !isPlaylist);
                this.dom.contentSearch.classList.toggle('hidden', isPlaylist);
                this.dom.contentSearch.classList.toggle('flex', !isPlaylist);
                setAccessibleTabState(this.dom.tabPlaylist, this.dom.contentPlaylist, isPlaylist);
                setAccessibleTabState(this.dom.tabSearch, this.dom.contentSearch, !isPlaylist);
            }

            // Data Logic
            loadPlaylist() { // Virtual scroll for mobile playlist (diff-based)
                try {
                    if (!window.playlist || !Array.isArray(window.playlist)) return;

                    const container = this.dom.playlistContainer;
                    const scrollParent = container.parentElement; // sheetContentPlaylist

                    let displayOrder = [];
                    if (playMode === 'shuffle' && shuffledOrder.length === window.playlist.length) {
                        displayOrder = shuffledOrder;
                    } else {
                        displayOrder = window.playlist.map((_, i) => i);
                    }

                    const MH = 64;  // item height, stable with 44px actions
                    const MB = 20;  // buffer
                    const totalHeight = displayOrder.length * MH;

                    container.innerHTML = '';
                    container.style.height = totalHeight + 'px';
                    container.style.position = 'relative';
                    container.classList.remove('pb-20');

                    let mRange = { start: -1, end: -1 };
                    let mRAF = null;
                    let mNodes = new Map(); // displayIndex -> DOM node
                    const self = this;

                    function mCreateItem(i) {
                        const actualIndex = displayOrder[i];
                        const song = window.playlist[actualIndex];
                        const isPlaying = actualIndex === currentIndex;
                        const textClass = isPlaying ? 'text-primary-color' : 'text-white/90';
                        const coverSrc = song.cover || '';

                        const div = document.createElement('div');
                        div.className = `flex items-center gap-2 px-3 rounded-xl border-b border-white/5 ${isPlaying ? 'bg-white/10' : ''}`;
                        div.style.cssText = `position:absolute;top:${i * MH}px;left:0;right:0;height:${MH}px;display:flex;align-items:center;`;
                        div.dataset.mvsIdx = i;
                        if (isPlaying) div.id = 'mobile-playing-item';

                        div.innerHTML = `
                            <button type="button" class="js-play-queue flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg" aria-label="播放「${escapeHtml(song.name || '未知歌曲')}」">
                                <span class="text-xs font-mono opacity-50 w-6 text-center flex-none">${i + 1}</span>
                                <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40" decoding="async" alt="" class="w-10 h-10 rounded-lg object-cover bg-white/5 flex-none" loading="lazy" crossorigin="anonymous">
                                <span class="flex-1 min-w-0">
                                    <span class="block font-bold truncate text-sm ${textClass}">${escapeHtml(song.name || '未知歌曲')}</span>
                                    <span class="block text-xs truncate opacity-50">${escapeHtml(song.artist || '')}</span>
                                </span>
                            </button>
                            <button type="button" class="js-add-playlist-item flex-none w-14 h-11 rounded-full border border-white/25 flex items-center justify-center gap-1 text-white/85 text-xs active:bg-white/10" title="收藏到歌单" aria-label="收藏到歌单" style="pointer-events:auto;z-index:5;position:relative;">
                                <i class="fas fa-folder-plus" aria-hidden="true"></i><span>歌单</span>
                            </button>
                            <button type="button" class="js-remove-queue flex-none w-14 h-11 rounded-full border border-white/25 flex items-center justify-center text-white/85 text-xs active:bg-red-500/40" title="从播放列表移除" aria-label="从播放列表移除" style="pointer-events:auto;z-index:5;position:relative;">
                                移除
                            </button>
                        `;
                        const playButton = div.querySelector('.js-play-queue');
                        const addPlaylistBtn = div.querySelector('.js-add-playlist-item');
                        if (addPlaylistBtn) {
                            addPlaylistBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.openAddToPlaylistModal(song);
                            };
                        }
                        const removeBtn = div.querySelector('.js-remove-queue');
                        if (removeBtn) {
                            removeBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (typeof window.removeSongFromQueue === 'function') {
                                    window.removeSongFromQueue(actualIndex);
                                }
                            };
                        }
                        if (playButton) {
                            playButton.onclick = () => {
                                playSongAtIndex(actualIndex);
                                self.closeSheet();
                            };
                        }

                        if (coverSrc) {
                            const img = div.querySelector('.js-play-queue img');
                            window.getCachedImage(`${coverSrc}?param=80y80`).then(cachedSrc => {
                                if (img.isConnected) img.src = cachedSrc;
                            });
                        }
                        return div;
                    }

                    function mRender(force) {
                        const st = scrollParent.scrollTop;
                        const vh = scrollParent.clientHeight;

                        let s = Math.max(0, Math.floor(st / MH) - MB);
                        let e = Math.min(displayOrder.length, Math.ceil((st + vh) / MH) + MB);

                        if (!force && s === mRange.start && e === mRange.end) return;

                        if (force) {
                            container.innerHTML = '';
                            mNodes.clear();
                            const frag = document.createDocumentFragment();
                            for (let i = s; i < e; i++) {
                                const node = mCreateItem(i);
                                mNodes.set(i, node);
                                frag.appendChild(node);
                            }
                            container.appendChild(frag);
                        } else {
                            // 移除离开范围的
                            for (let i = mRange.start; i < mRange.end; i++) {
                                if (i < s || i >= e) {
                                    const node = mNodes.get(i);
                                    if (node && node.parentNode) node.parentNode.removeChild(node);
                                    mNodes.delete(i);
                                }
                            }
                            // 添加新进入范围的
                            const frag = document.createDocumentFragment();
                            let added = false;
                            for (let i = s; i < e; i++) {
                                if (!mNodes.has(i)) {
                                    const node = mCreateItem(i);
                                    mNodes.set(i, node);
                                    frag.appendChild(node);
                                    added = true;
                                }
                            }
                            if (added) container.appendChild(frag);
                        }
                        mRange = { start: s, end: e };
                    }

                    mRender(true);

                    scrollParent.onscroll = () => {
                        if (mRAF) return;
                        mRAF = requestAnimationFrame(() => {
                            mRAF = null;
                            mRender(false);
                        });
                    };

                    // 自动滚动到当前播放
                    const playingPos = displayOrder.indexOf(currentIndex);
                    if (playingPos !== -1) {
                        requestAnimationFrame(() => {
                            const targetTop = playingPos * MH - scrollParent.clientHeight / 2 + MH / 2;
                            scrollParent.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
                        });
                    }
                } catch (e) {
                    console.error('Failed to load playlist', e);
                    this.dom.playlistContainer.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">加载失败</div>';
                }
            }

            async handleSearch(query) {
                query = String(query || '').trim();
                const requestId = ++this.searchRequestId;
                if (!query) {
                    this.dom.searchResults.innerHTML = '';
                    return;
                }

                // [紧急Fix] 纯数字ID直接添加并播放
                if (/^\d+$/.test(query.trim())) {
                    const container = this.dom.searchResults;
                    container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">正在加载ID歌曲...</div>';

                    try {
                        const songData = await musicService.getSong(query);
                        if (requestId !== this.searchRequestId) return;
                        if (songData && songData.url) {
                            const newSong = {
                                id: songData.id,
                                name: songData.name,
                                artist: songData.artist,
                                cover: songData.cover,
                                album: songData.album || '',
                                source: 'id_search'
                            };

                            // 插入到播放列表
                            // 直接访问 module scope 的变量
                            const targetIndex = window.insertSongToPlaylist(newSong);

                            // 刷新所有 UI
                            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                            this.loadPlaylist();

                            // 播放
                            window.playSongAtIndex(targetIndex);

                            this.closeSheet();
                            showToast(`已添加并播放: ${newSong.name}`);
                            if (this.dom.searchInput) this.dom.searchInput.value = '';
                        } else {
                            container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">无效的ID</div>';
                        }
                    } catch (e) {
                        if (requestId !== this.searchRequestId) return;
                        console.error(e);
                        const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
                        if (failure.kind === 'auth') {
                            renderSearchRecoveryState(container, {
                                query: query,
                                error: e,
                                compact: true,
                                onRetry: (retryQuery) => this.handleSearch(retryQuery)
                            });
                        } else {
                            container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">加载失败</div>';
                        }
                    }
                    return;
                }

                const container = this.dom.searchResults;
                container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">搜索中...</div>';

                try {
                    // Use global musicService instance
                    const results = await musicService.search(query);
                    if (requestId !== this.searchRequestId) return;
                    container.innerHTML = '';
                    container.classList.remove('hidden');

                    if (!results || results.length === 0) {
                        container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">无结果</div>';
                        return;
                    }

                    results.forEach(song => {
                        const div = document.createElement('div');
                        div.className = 'flex items-center gap-2 p-2 rounded-xl active:bg-white/5 transition-colors';

                        div.innerHTML = `
                            <button type="button" class="js-play-search flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg" aria-label="添加并播放「${escapeHtml(song.name || '未知歌曲')}」">
                                <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCI+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iIzMzMyIvPjwvc3ZnPg==" width="40" height="40" decoding="async" alt="" class="w-10 h-10 rounded-lg object-cover bg-white/5 flex-none shadow-md" loading="lazy" crossorigin="anonymous">
                                <span class="flex-1 min-w-0">
                                    <span class="block font-bold truncate text-sm text-white/90">${escapeHtml(song.name || '未知歌曲')}</span>
                                    <span class="block text-xs truncate opacity-50">${escapeHtml(song.artist || '')}</span>
                                </span>
                            </button>
                            <button type="button" class="js-add-queue p-2 w-12 h-11 gap-1 flex items-center justify-center rounded-full border border-white/20 text-xs" title="加入播放列表（不立即播放）" aria-label="加入播放列表（不立即播放）">
                                <i class="fas fa-plus" aria-hidden="true"></i><span>加入</span>
                            </button>
                            <button type="button" class="js-add-playlist p-2 w-14 h-11 gap-1 flex items-center justify-center rounded-full border border-white/20 text-xs" title="收藏到歌单" aria-label="收藏到歌单">
                                <i class="fas fa-folder-plus" aria-hidden="true"></i><span>歌单</span>
                            </button>
                        `;

                        if (song.cover) {
                            const image = div.querySelector('.js-play-search img');
                            window.getCachedImage(`${song.cover}?param=80y80`).then(cachedSrc => {
                                if (image && image.isConnected) image.src = cachedSrc;
                            });
                        }

                        const newSong = {
                            id: song.id, name: song.name, artist: song.artist,
                            cover: song.cover, album: song.album, source: 'netease'
                        };
                        try {
                            const payload = JSON.stringify(newSong);
                            const aq = div.querySelector('.js-add-queue');
                            const ap = div.querySelector('.js-add-playlist');
                            if (aq) aq.dataset.song = payload;
                            if (ap) ap.dataset.song = payload;
                            if (aq) aq.onclick = (e) => {
                                e.preventDefault(); e.stopPropagation();
                                window.addSongToQueueOnly(newSong);
                                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                                this.loadPlaylist();
                            };
                            if (ap) ap.onclick = function (e) {
                                e.preventDefault(); e.stopPropagation();
                                window.openAddToPlaylistModal(newSong);
                            };
                        } catch (e) {}
                        const playButton = div.querySelector('.js-play-search');
                        playButton.onclick = () => {
                            const targetIndex = window.insertSongToPlaylist(newSong);
                            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                            this.loadPlaylist();
                            if (typeof window.playSongAtIndex === 'function') window.playSongAtIndex(targetIndex);
                            this.closeSheet();
                            showToast('已添加并播放: ' + song.name);
                        };
                        container.appendChild(div);
                    });

                } catch (e) {
                    if (requestId !== this.searchRequestId) return;
                    console.error('Search failed', e);
                    renderSearchRecoveryState(container, {
                        query: query,
                        error: e,
                        compact: true,
                        onRetry: (retryQuery) => this.handleSearch(retryQuery)
                    });
                }
            }

            handleResize() {
                const isNowMobile = isMobileLayoutViewport();
                if (this.isMobile !== isNowMobile) {
                    this.isMobile = isNowMobile;
                    if (!this.isMobile) {
                        this.closeSheet();
                    }
                }
            }

            // View Toggles
            toggleView() {
                this.currentMode = this.currentMode === 'cover' ? 'lyrics' : 'cover';

                if (this.currentMode === 'cover') {
                    // Show Cover
                    this.dom.mobileCoverContainer.classList.remove('opacity-0', 'pointer-events-none', 'translate-x-[-100%]');
                    this.dom.mobileCoverContainer.classList.add('opacity-100', 'translate-x-0');

                    // Hide Lyrics
                    this.dom.mobileLyricsContainer.classList.add('opacity-0', 'pointer-events-none', 'translate-x-full');
                    this.dom.mobileLyricsContainer.classList.remove('opacity-100', 'translate-x-0');
                } else {
                    // Hide Cover
                    this.dom.mobileCoverContainer.classList.add('opacity-0', 'pointer-events-none', 'translate-x-[-100%]');
                    this.dom.mobileCoverContainer.classList.remove('opacity-100', 'translate-x-0');

                    // Show Lyrics
                    this.dom.mobileLyricsContainer.classList.remove('opacity-0', 'pointer-events-none', 'translate-x-full');
                    this.dom.mobileLyricsContainer.classList.add('opacity-100', 'translate-x-0');
                }
                const showingLyrics = this.currentMode === 'lyrics';
                this.dom.mobileCoverContainer.setAttribute('aria-hidden', String(showingLyrics));
                this.dom.mobileCoverContainer.inert = showingLyrics;
                this.dom.mobileLyricsContainer.setAttribute('aria-hidden', String(!showingLyrics));
                this.dom.mobileLyricsContainer.inert = !showingLyrics;
                if (this.dom.viewToggle) {
                    const label = showingLyrics ? '返回封面' : '查看歌词';
                    this.dom.viewToggle.setAttribute('aria-pressed', String(showingLyrics));
                    this.dom.viewToggle.setAttribute('aria-label', label);
                    this.dom.viewToggle.title = label;
                    const icon = this.dom.viewToggle.querySelector('i');
                    if (icon) icon.className = showingLyrics ? 'fas fa-compact-disc' : 'fas fa-align-left';
                }
            }

            resetView() {
                if (this.currentMode !== 'cover') this.toggleView();
            }

            // Updates - 带过渡动画
            updateInfo(title, artist, cover) {
                const elements = [this.dom.title, this.dom.artist, this.dom.coverImg].filter(Boolean);

                // 淡出
                elements.forEach(el => el.style.transition = 'opacity 0.2s ease');
                elements.forEach(el => el.style.opacity = '0');

                setTimeout(() => {
                    // 更新内容
                    if (this.dom.title) this.dom.title.textContent = title;
                    if (this.dom.artist) this.dom.artist.textContent = artist;
                    if (this.dom.coverImg) this.dom.coverImg.src = cover;

                    // Sync metadata badges from desktop DOM
                    const desktopSource = document.getElementById('sourceTag');
                    if (this.dom.sourceTag && desktopSource) {
                        this.dom.sourceTag.textContent = desktopSource.textContent;
                        this.dom.sourceTag.classList.toggle('hidden', desktopSource.classList.contains('hidden'));
                    }

                    const desktopId = document.getElementById('songIdTag');
                    if (this.dom.songIdTag && desktopId) {
                        this.dom.songIdTag.textContent = desktopId.textContent;
                        this.dom.songIdTag.className = desktopId.className;
                    }

                    // 淡入
                    requestAnimationFrame(() => {
                        elements.forEach(el => el.style.opacity = '1');
                    });
                }, 200); // 等淡出完成
            }

            updatePlayState(isPlaying) {
                if (this.dom.vinyl) {
                    this.dom.vinyl.classList.toggle('playing', isPlaying);
                }
                const icon = this.dom.playBtn?.querySelector('i');
                if (icon) icon.className = isPlaying ? 'fas fa-pause pl-0' : 'fas fa-play pl-1';
            }

            updateProgress(currentTime, duration, progressPercent) {
                if (this.dom.currentTime) this.dom.currentTime.textContent = formatTime(currentTime);
                if (this.dom.duration) this.dom.duration.textContent = formatTime(duration);
                if (this.dom.progressBar) this.dom.progressBar.style.width = `${progressPercent}%`;
                syncProgressAccessibility(this.dom.progressContainer, currentTime, duration);
            }
        }

        // Global Instance
        let mobileUI = null;

        // ================= ★ FluidBackground (复制 aura-music WebGL) =================
        class FluidBackground {
            constructor(canvasId) {
                this.canvas = document.getElementById(canvasId);
                if (!this.canvas) return;

                this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
                if (!this.gl) {
                    console.warn('WebGL 不支持');
                    return;
                }

                this.isPlaying = false;
                this.animationFrameId = null;
                this.boundAnimate = () => this.animate();
                this.timeAccumulator = 0;
                this.lastFrameTime = performance.now();

                // 默认颜色 (aura-music)
                this.colors = [
                    'rgb(60, 20, 80)',
                    'rgb(100, 40, 60)',
                    'rgb(20, 20, 40)',
                    'rgb(40, 40, 90)'
                ];

                this.initShader();
                this.resize();
                this.render();
                this.setPlaying(isPlaying);
                window.addEventListener('resize', () => this.resize());
            }

            parseColor(colorStr) {
                const match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                if (!match) return [0, 0, 0];
                return [parseInt(match[1], 10) / 255, parseInt(match[2], 10) / 255, parseInt(match[3], 10) / 255];
            }

            initShader() {
                const gl = this.gl;
                const vs = `attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
                const fs = `
                    precision highp float;
                    uniform vec2 uResolution; uniform float uTime;
                    uniform vec3 uColor1, uColor2, uColor3, uColor4;
                    #define S(a,b,t) smoothstep(a,b,t)
                    mat2 Rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
                    vec2 hash(vec2 p) { p = vec2(dot(p, vec2(2127.1, 81.17)), dot(p, vec2(1269.5, 283.37))); return fract(sin(p) * 43758.5453); }
                    float noise(vec2 p) {
                        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
                        float n = mix(mix(dot(-1.0 + 2.0 * hash(i), f), dot(-1.0 + 2.0 * hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
                                      mix(dot(-1.0 + 2.0 * hash(i + vec2(0,1)), f - vec2(0,1)), dot(-1.0 + 2.0 * hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
                        return 0.5 + 0.5 * n;
                    }
                    void main() {
                        vec2 uv = gl_FragCoord.xy / uResolution.xy;
                        float ratio = uResolution.x / uResolution.y;
                        vec2 tuv = uv - 0.5;
                        float degree = noise(vec2(uTime * 0.1, tuv.x * tuv.y));
                        tuv.y *= 1.0 / ratio;
                        tuv *= Rot(radians((degree - 0.5) * 720.0 + 180.0));
                        tuv.y *= ratio;
                        float frequency = 5.0, amplitude = 30.0, speed = uTime * 2.0;
                        tuv.x += sin(tuv.y * frequency + speed) / amplitude;
                        tuv.y += sin(tuv.x * frequency * 1.5 + speed) / (amplitude * 0.5);
                        vec3 layer1 = mix(uColor1, uColor2, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
                        vec3 layer2 = mix(uColor3, uColor4, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
                        gl_FragColor = vec4(mix(layer1, layer2, S(0.5, -0.3, tuv.y)), 1.0);
                    }
                `;
                const createShader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
                const vShader = createShader(gl.VERTEX_SHADER, vs), fShader = createShader(gl.FRAGMENT_SHADER, fs);
                if (!vShader || !fShader) return;
                this.program = gl.createProgram();
                gl.attachShader(this.program, vShader); gl.attachShader(this.program, fShader);
                gl.linkProgram(this.program); gl.useProgram(this.program);
                const posBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
                const posLoc = gl.getAttribLocation(this.program, 'position');
                gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
                this.uResolution = gl.getUniformLocation(this.program, 'uResolution');
                this.uTime = gl.getUniformLocation(this.program, 'uTime');
                this.uColor1 = gl.getUniformLocation(this.program, 'uColor1');
                this.uColor2 = gl.getUniformLocation(this.program, 'uColor2');
                this.uColor3 = gl.getUniformLocation(this.program, 'uColor3');
                this.uColor4 = gl.getUniformLocation(this.program, 'uColor4');
            }

            resize() {
                if (!this.gl) return;
                this.canvas.width = window.innerWidth;
                this.canvas.height = window.innerHeight;
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                if (document.visibilityState === 'visible' && !this.shouldAnimate()) this.render();
            }

            async extractColorsFromImage(imgUrl) {
                try {
                    // console.log('🎨 开始从封面提取颜色:', imgUrl);
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.src = imgUrl;

                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        setTimeout(reject, 5000); // 5秒超时
                    });

                    if (typeof ColorThief !== 'undefined') {
                        const colorThief = new ColorThief();
                        const palette = colorThief.getPalette(img, 4);
                        // console.log('🎨 ColorThief 提取的调色板:', palette);

                        if (palette && palette.length >= 4) {
                            // 确保格式正确：rgb(r, g, b) 带空格
                            this.setColors(palette.map(([r, g, b]) => {
                                const factor = 0.8;
                                const nr = Math.round(r * factor);
                                const ng = Math.round(g * factor);
                                const nb = Math.round(b * factor);
                                return `rgb(${nr}, ${ng}, ${nb})`;
                            }));
                            console.log('🎨 更新后的背景颜色:', this.colors);
                            return;
                        }
                    } else {
                        console.warn('⚠️ ColorThief 未加载');
                    }

                    // 降级：简单采样四个角落的颜色
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = 2;
                    canvas.height = 2;
                    ctx.drawImage(img, 0, 0, 2, 2);
                    const data = ctx.getImageData(0, 0, 2, 2).data;

                    this.setColors([
                        `rgb(${Math.round(data[0] * 0.8)}, ${Math.round(data[1] * 0.8)}, ${Math.round(data[2] * 0.8)})`,
                        `rgb(${Math.round(data[4] * 0.8)}, ${Math.round(data[5] * 0.8)}, ${Math.round(data[6] * 0.8)})`,
                        `rgb(${Math.round(data[8] * 0.8)}, ${Math.round(data[9] * 0.8)}, ${Math.round(data[10] * 0.8)})`,
                        `rgb(${Math.round(data[12] * 0.8)}, ${Math.round(data[13] * 0.8)}, ${Math.round(data[14] * 0.8)})`
                    ]);
                    console.log('🎨 降级采样的背景颜色:', this.colors);
                } catch (e) {
                    console.warn('❌ 颜色提取失败:', e);
                }
            }

            render() {
                if (!this.gl || !this.program) return;
                const gl = this.gl, now = performance.now(), delta = now - this.lastFrameTime;
                this.lastFrameTime = now;
                if (this.isPlaying) this.timeAccumulator += delta;
                gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                gl.useProgram(this.program);
                gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
                gl.uniform1f(this.uTime, this.timeAccumulator * 0.0005);
                const [c1, c2, c3, c4] = this.colors.map(c => this.parseColor(c));
                gl.uniform3f(this.uColor1, c1[0], c1[1], c1[2]);
                gl.uniform3f(this.uColor2, c2[0], c2[1], c2[2]);
                gl.uniform3f(this.uColor3, c3[0], c3[1], c3[2]);
                gl.uniform3f(this.uColor4, c4[0], c4[1], c4[2]);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }

            shouldAnimate() {
                return !!(this.gl && this.program && this.isPlaying && !prefersReducedMotion() && document.visibilityState === 'visible');
            }

            syncAnimation() {
                if (this.shouldAnimate()) {
                    if (this.animationFrameId === null) {
                        this.lastFrameTime = performance.now();
                        this.animationFrameId = requestAnimationFrame(this.boundAnimate);
                    }
                    return;
                }
                if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
                this.animationFrameId = null;
                if (document.visibilityState === 'visible') this.render();
            }

            animate() {
                this.animationFrameId = null;
                if (!this.shouldAnimate()) return;
                this.render();
                this.animationFrameId = requestAnimationFrame(this.boundAnimate);
            }

            setPlaying(p) {
                this.isPlaying = !!p;
                this.syncAnimation();
            }

            setColors(c) {
                if (!c || c.length < 4) return;
                this.colors = c;
                if (!this.shouldAnimate()) this.render();
            }
        }

        // ================= ★ Canvas 歌词渲染器 (参考 aura-music 效果) =================
        class LyricsCanvasRenderer {
            constructor(canvasId) {
                this.canvas = document.getElementById(canvasId);
                if (!this.canvas) return;

                this.ctx = this.canvas.getContext('2d');
                this.pixelRatio = window.devicePixelRatio || 1;
                this.lines = [];
                this.activeIndex = -1;
                this.scrollY = 0;
                this.targetScrollY = 0;
                this.scrollVelocity = 0;
                this.isDragging = false;
                this.lastTouchY = 0;
                this.lastInteractionTime = 0;
                this.isAnimating = false;

                this.resize();
                this.bindEvents();

                window.addEventListener('resize', () => this.resize());
            }

            resize() {
                if (!this.canvas) return;
                const rect = this.canvas.parentElement.getBoundingClientRect();
                this.width = rect.width;
                this.height = rect.height;
                this.canvas.width = this.width * this.pixelRatio;
                this.canvas.height = this.height * this.pixelRatio;
                this.canvas.style.width = this.width + 'px';
                this.canvas.style.height = this.height + 'px';
                this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
            }

            bindEvents() {
                // 鼠标/触摸交互
                this.canvas.addEventListener('mousedown', e => this.onPointerDown(e.clientY));
                this.canvas.addEventListener('mousemove', e => this.onPointerMove(e.clientY));
                this.canvas.addEventListener('mouseup', () => this.onPointerUp());
                this.canvas.addEventListener('mouseleave', () => this.onPointerUp());

                this.canvas.addEventListener('touchstart', e => {
                    e.preventDefault();
                    this.onPointerDown(e.touches[0].clientY);
                }, { passive: false });
                this.canvas.addEventListener('touchmove', e => {
                    e.preventDefault();
                    this.onPointerMove(e.touches[0].clientY);
                }, { passive: false });
                this.canvas.addEventListener('touchend', () => this.onPointerUp());

                // 鼠标滚轮
                this.canvas.addEventListener('wheel', e => {
                    e.preventDefault();
                    this.lastInteractionTime = performance.now();
                    this.targetScrollY += e.deltaY * 0.5;
                    this.clampScroll();
                }, { passive: false });

                // 点击跳转
                this.canvas.addEventListener('click', e => {
                    if (this.isDragging) return;
                    const rect = this.canvas.getBoundingClientRect();
                    const clickY = e.clientY - rect.top;
                    this.handleClick(clickY);
                });
            }

            onPointerDown(y) {
                this.isDragging = true;
                this.lastTouchY = y;
                this.scrollVelocity = 0;
                this.lastInteractionTime = performance.now();
            }

            onPointerMove(y) {
                if (!this.isDragging) return;
                const dy = this.lastTouchY - y;
                this.scrollVelocity = dy * 60;
                this.targetScrollY += dy;
                this.lastTouchY = y;
                this.clampScroll();
            }

            onPointerUp() {
                this.isDragging = false;
                this.lastInteractionTime = performance.now();
            }

            clampScroll() {
                const totalHeight = this.lines.reduce((sum, l) => sum + l.height + 16, 0);
                const maxScroll = Math.max(0, totalHeight - this.height * 0.5);
                this.targetScrollY = Math.max(-this.height * 0.3, Math.min(maxScroll, this.targetScrollY));
            }

            handleClick(clickY) {
                const focalY = this.height * 0.35;
                let y = focalY - this.scrollY;

                for (let i = 0; i < this.lines.length; i++) {
                    const line = this.lines[i];
                    const lineBottom = y + line.height;

                    if (clickY >= y && clickY <= lineBottom) {
                        // 点击跳转播放
                        audio.currentTime = line.time;
                        audio.play();
                        break;
                    }
                    y = lineBottom + 16;
                }
            }

            setLyrics(parsedLyrics) {
                this.lines = parsedLyrics.map((item, idx) => ({
                    time: item.time,
                    text: item.text,
                    words: [],
                    translation: item.html?.includes('lyric-trans')
                        ? item.html.match(/<div class="lyric-trans">(.*?)<\/div>/)?.[1]
                        : null,
                    height: 0,  // 动态计算
                    measured: false
                }));

                this.measureLines();
                this.scrollY = -this.height * 0.3;
                this.targetScrollY = this.scrollY;
                this.activeIndex = -1;

                if (!this.isAnimating) {
                    this.isAnimating = true;
                    this.animate();
                }
            }

            measureLines() {
                const ctx = this.ctx;
                const isMobile = this.width < 768; // Match aura-music breakpoint
                // ★ 字体配置 (aura-music)
                const baseSize = isMobile ? 32 : 40;
                const transSize = isMobile ? 18 : 22;
                const mainFont = `800 ${baseSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
                const transFont = `500 ${transSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
                this.paddingX = isMobile ? 24 : 56; // 增加边距
                const maxWidth = this.width - this.paddingX * 2;

                this.lines.forEach(line => {
                    ctx.font = mainFont;
                    const mainMetrics = ctx.measureText(line.text || '');
                    const mainWidth = mainMetrics.width;
                    const mainLines = Math.ceil(mainWidth / maxWidth);
                    const mainHeight = mainLines * (baseSize * 1.35); // line-height 1.35

                    let transHeight = 0;
                    if (line.translation) {
                        ctx.font = transFont;
                        const transMetrics = ctx.measureText(line.translation);
                        const transLines = Math.ceil(transMetrics.width / maxWidth);
                        transHeight = transLines * (transSize * 1.3) + 8; // margin-top 8
                    }

                    line.height = mainHeight + transHeight + 20; // margin-bottom 20
                    line.measured = true;
                });
            }

            update(currentTime) {
                if (!this.lines.length) return;

                // 找当前行
                let newActive = 0;
                for (let i = 0; i < this.lines.length; i++) {
                    if (this.lines[i].time <= currentTime + 0.2) { // Slightly fast anticipation
                        newActive = i;
                    } else {
                        break;
                    }
                }

                // 更新滚动目标
                const userScrolling = performance.now() - this.lastInteractionTime < 3000;
                if (!userScrolling && !this.isDragging) {
                    // 计算目标行位置
                    let targetY = 0;
                    for (let i = 0; i < newActive; i++) {
                        targetY += this.lines[i].height;
                    }
                    targetY += this.lines[newActive]?.height * 0.5 || 0;
                    this.targetScrollY = targetY;
                }

                this.activeIndex = newActive;

                // ★ 弹簧物理滚动 (aura-music 参数)
                // Stiffness: 120 (loose) -> 300-400 (snap)
                // Damping: 20 -> 35-40
                const stiffness = this.isDragging ? 0 : (userScrolling ? 150 : 350);
                const damping = this.isDragging ? 10 : 35;
                const dt = 1 / 60;

                const displacement = this.scrollY - this.targetScrollY;
                const springForce = -stiffness * displacement;
                const dampingForce = -damping * this.scrollVelocity;
                const acceleration = springForce + dampingForce;

                this.scrollVelocity += acceleration * dt;
                this.scrollY += this.scrollVelocity * dt;

                if (Math.abs(this.scrollVelocity) < 0.1 && Math.abs(displacement) < 0.5) {
                    this.scrollY = this.targetScrollY;
                    this.scrollVelocity = 0;
                }
            }

            render(currentTime) {
                const ctx = this.ctx;
                ctx.clearRect(0, 0, this.width, this.height);

                if (!this.lines.length) {
                    ctx.fillStyle = 'rgba(255,255,255,0.4)';
                    ctx.font = '800 24px "PingFang SC", sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('♪ 播放音乐以查看歌词', this.width / 2, this.height / 2);
                    return;
                }

                const isMobile = this.width < 768;
                const baseSize = isMobile ? 32 : 40;
                const transSize = isMobile ? 18 : 22;
                const mainFont = `800 ${baseSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
                const transFont = `500 ${transSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;

                // Focal Point: 35% from top (desktop) or near center?
                // aura-music uses 0.35 (ish)
                const focalY = this.height * 0.35;

                let y = focalY - this.scrollY;

                for (let i = 0; i < this.lines.length; i++) {
                    const line = this.lines[i];
                    const lineBottom = y + line.height;

                    // 视口裁剪
                    if (lineBottom < -100 || y > this.height + 100) {
                        y = lineBottom; // Note: margin included in line.height now
                        continue;
                    }

                    const isActive = i === this.activeIndex;

                    // 渐变与模糊逻辑
                    const distFromFocal = Math.abs(y + line.height / 2 - focalY);
                    const normDist = Math.min(distFromFocal / (this.height * 0.5), 1);

                    // aura-music opacity logic
                    let opacity = isActive ? 1 : 0.3 + (0.7 * (1 - Math.pow(normDist, 0.5))) * 0.2;
                    // Simplified: Active 1.0, others 0.3 dim
                    if (!isActive) opacity = 0.3; // Stricter contrast like aura-music

                    ctx.save();
                    ctx.globalAlpha = opacity;

                    // 缩放效果 (aura-music: Active 1.03, others 1.0)
                    const scale = isActive ? 1.03 : 1.0;

                    // Center of the line for scaling (vertically), but left aligned horizontally
                    const centerY = y + line.height / 2;
                    // Translate to paddingX, centerY
                    ctx.translate(this.paddingX, centerY);
                    ctx.scale(scale, scale);
                    // Translate back up to top-left of text block (relative to center)
                    ctx.translate(0, -line.height / 2);

                    // 渲染主歌词
                    ctx.font = mainFont;
                    ctx.textBaseline = 'top';
                    ctx.textAlign = 'left'; // 明确左对齐

                    // aura-music: Active White, Inactive White (opacity handles dimming usually, or explicit color)
                    // Inactiv color is rgba(255,255,255,0.85) but with opacity 0.3 applied globally
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillText(line.text, 0, 0);

                    // 渲染翻译
                    if (line.translation) {
                        ctx.font = transFont;
                        ctx.fillStyle = 'rgba(255,255,255,0.6)';
                        ctx.fillText(line.translation, 0, baseSize * 1.35 + 8);
                    }

                    ctx.restore();

                    y = lineBottom;
                }

                // 顶部/底部渐隐遮罩
                this.drawMask(ctx);
            }



            drawMask(ctx) {
                // 顶部渐隐
                const topGradient = ctx.createLinearGradient(0, 0, 0, this.height * 0.15);
                topGradient.addColorStop(0, 'rgba(0,0,0,1)');
                topGradient.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillStyle = topGradient;
                ctx.fillRect(0, 0, this.width, this.height * 0.15);

                // 底部渐隐
                const bottomGradient = ctx.createLinearGradient(0, this.height * 0.85, 0, this.height);
                bottomGradient.addColorStop(0, 'rgba(0,0,0,0)');
                bottomGradient.addColorStop(1, 'rgba(0,0,0,1)');
                ctx.fillStyle = bottomGradient;
                ctx.fillRect(0, this.height * 0.85, this.width, this.height * 0.15);

                ctx.globalCompositeOperation = 'source-over';
            }

            animate() {
                if (!this.isAnimating) return;

                const time = audio?.currentTime || 0;
                this.update(time);
                this.render(time);

                requestAnimationFrame(() => this.animate());
            }

            stop() {
                this.isAnimating = false;
            }
        }

        // ★ 全局实例
        let fluidBg = null;
        let lyricsCanvas = null;

        // 初始化渲染器
        function initCanvasRenderers() {
            if (!fluidBg) fluidBg = new FluidBackground('fluidBg');
            if (!lyricsCanvas) lyricsCanvas = new LyricsCanvasRenderer('lyricsCanvas');
            if (!mobileUI) {
                mobileUI = new MobileUIManager();
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
