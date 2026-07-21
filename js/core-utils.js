/**
 * Small, browser-safe primitives shared by the player and Node tests.
 * Keep this module free of DOM and storage dependencies.
 */

export const API_REQUEST_TIMEOUT_MS = 15000;
export const API_REQUEST_RETRIES = 1;
export const API_RETRY_DELAY_MS = 350;
export const PLAYBACK_SESSION_VERSION = 1;
export const PLAYBACK_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeArtist(value) {
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (item && typeof item === 'object') return item.name || '';
            return String(item || '');
        }).filter(Boolean).join(', ');
    }
    if (value && typeof value === 'object') return value.name || '';
    return value ? String(value) : '';
}

/** Normalize API, imported, and primitive queue entries to one stable shape. */
export function normalizeSongObject(song) {
    if (song == null) return null;
    if (typeof song !== 'object') {
        song = { id: song, name: '歌曲 ID: ' + song };
    }

    const album = song.album && typeof song.album === 'object'
        ? (song.album.name || '')
        : (song.album || '');

    return {
        id: song.id,
        name: song.name || '未知歌曲',
        artist: normalizeArtist(song.artist || song.artists) || '未知艺术家',
        cover: song.cover || song.picUrl || '',
        album,
        source: song.source || 'Search'
    };
}

function qualityResult(text, className, icon, detail, source) {
    return { text, className, icon, detail, source };
}

function normalizeBitrate(bitrate) {
    if (typeof bitrate === 'string' && bitrate.trim() === '') return null;
    const value = Number(bitrate);
    if (!Number.isFinite(value) || value < 128000) return null;
    return value;
}

function bitrateLabel(bitrate) {
    return Math.round(bitrate / 1000) + ' kbps';
}

function hasFlacExtension(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
        return new URL(url, 'https://quality.local').pathname.toLowerCase().endsWith('.flac');
    } catch (error) {
        return false;
    }
}

/**
 * Classify only what upstream metadata or conservative local evidence supports.
 * A requested quality is deliberately not accepted as proof of the delivered stream.
 */
export function classifyPlaybackQuality({ level, url, bitrate } = {}) {
    const normalizedLevel = typeof level === 'string'
        ? level.trim().toLowerCase().replace(/[\s_-]+/g, '')
        : '';
    const apiLevels = {
        jymaster: qualityResult('标注 JyMaster', 'quality-lossless', '💎', '上游 API 标注为 JyMaster', 'api'),
        hires: qualityResult('标注 Hi-Res', 'quality-hires', '✨', '上游 API 标注为 Hi-Res', 'api'),
        lossless: qualityResult('标注 无损', 'quality-lossless', '💿', '上游 API 标注为无损', 'api'),
        exhigh: qualityResult('标注 高音质', 'quality-high', '🎵', '上游 API 标注为高音质', 'api'),
        higher: qualityResult('标注 高音质', 'quality-high', '🎵', '上游 API 标注为高音质', 'api'),
        standard: qualityResult('标注 标准', 'quality-standard', '🎶', '上游 API 标注为标准', 'api')
    };
    if (apiLevels[normalizedLevel]) return apiLevels[normalizedLevel];

    const normalizedBitrate = normalizeBitrate(bitrate);
    if (hasFlacExtension(url)) {
        return qualityResult('无损', 'quality-lossless', '💿', '依据 URL 的 FLAC 扩展名推断为无损', 'inferred');
    }
    if (normalizedBitrate >= 900000) {
        return qualityResult('无损', 'quality-lossless', '💿', `依据 ${bitrateLabel(normalizedBitrate)} 码率推断为无损`, 'inferred');
    }
    if (normalizedBitrate >= 192000) {
        return qualityResult('高音质', 'quality-high', '🎵', `依据 ${bitrateLabel(normalizedBitrate)} 码率推断为高音质`, 'inferred');
    }
    if (normalizedBitrate >= 128000) {
        return qualityResult('标准', 'quality-standard', '🎶', `依据 ${bitrateLabel(normalizedBitrate)} 码率推断为标准`, 'inferred');
    }
    return qualityResult('音质未标注', 'quality-unknown', '？', '上游 API 未提供可信的音质等级或码率', 'unknown');
}

/** Return a seek position only when at least five seconds remain in the track. */
export function getSafePlaybackResumeTime(currentTime, duration) {
    const position = Number(currentTime);
    const total = Number(duration);
    if (!Number.isFinite(position) || !Number.isFinite(total) || total <= 0) return 0;
    if (position < 5 || position >= total - 5) return 0;
    return position;
}

/** Validate the small localStorage record used for click-to-resume playback. */
export function normalizePlaybackSession(value, options = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.version !== PLAYBACK_SESSION_VERSION) return null;

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const maxAgeMs = Number.isFinite(options.maxAgeMs)
        ? Math.max(0, options.maxAgeMs)
        : PLAYBACK_SESSION_MAX_AGE_MS;
    const updatedAt = Number(value.updatedAt);
    const currentTime = Number(value.currentTime);
    const duration = Number(value.duration);
    const rawSongId = value.songId;
    const songId = typeof rawSongId === 'string' || typeof rawSongId === 'number'
        ? String(rawSongId).trim()
        : '';
    const currentIndex = Number(value.currentIndex);

    if (!songId || !Number.isInteger(currentIndex) || currentIndex < 0) return null;
    if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > now + 5 * 60 * 1000) return null;
    if (now - updatedAt > maxAgeMs) return null;
    if (!getSafePlaybackResumeTime(currentTime, duration)) return null;

    return {
        version: PLAYBACK_SESSION_VERSION,
        songId,
        currentIndex,
        currentTime,
        duration,
        wasPlaying: value.wasPlaying === true,
        updatedAt
    };
}

/** Return zero for missing, invalid, or expired sleep deadlines. */
export function getSleepTimerRemainingMs(endAt, now = Date.now()) {
    const deadline = Number(endAt);
    const current = Number(now);
    if (!Number.isFinite(deadline) || !Number.isFinite(current) || deadline <= current) return 0;
    return deadline - current;
}

/** Turn low-level request/media errors into stable user-facing categories. */
export function classifyPlaybackFailure(error, online = true) {
    if (online === false) return { kind: 'offline', message: '当前已断网' };

    const name = error && error.name ? String(error.name) : '';
    const message = error && error.message ? String(error.message).toLowerCase() : '';
    const status = error && Number.isFinite(Number(error.status)) ? Number(error.status) : 0;
    // 401/403 means the API key is missing/invalid or the daily quota is used up.
    // Retrying will not help, so surface a distinct, actionable message.
    const authFailure = status === 401 || status === 403 ||
        message.includes('apikey') || message.includes('api key') ||
        message.includes('未授权') || message.includes('密钥');
    if (authFailure) return { kind: 'auth', message: 'API 密钥无效或额度已用完，请在设置中检查密钥' };

    const networkFailure = name === 'TimeoutError' || error instanceof TypeError ||
        status === 429 || status >= 500 || message.includes('network') ||
        message.includes('网络请求') || message.includes('fetch');
    if (networkFailure) return { kind: 'service', message: '音乐服务暂时不可用' };

    const unavailable = status === 404 || message.includes('getsong failed') ||
        message.includes('no data') || message.includes('no playable') ||
        message.includes('unsupported') || message.includes('decode error') ||
        message.includes('invalid media url');
    if (unavailable) return { kind: 'unavailable', message: '这首歌暂时没有可用音源' };

    return { kind: 'unknown', message: '这首歌播放失败' };
}

/** Return true only for failures where another request can plausibly help. */
export function shouldRetryRequest(error) {
    if (!error) return false;
    if (error.retryable === true) return true;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    if (typeof error.status === 'number') return error.status >= 500 && error.status <= 599;
    // Browsers report network-level fetch failures as TypeError.
    return error instanceof TypeError;
}

function createHttpError(status) {
    const error = new Error('网络请求失败 (' + status + ')');
    error.status = status;
    error.retryable = status >= 500 && status <= 599;
    return error;
}

/**
 * Fetch JSON with an AbortController timeout and bounded retry policy.
 * `fetchImpl` and `sleepImpl` are injectable to keep tests deterministic.
 */
export async function fetchJsonWithRetry(url, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
        ? Math.max(1, options.timeoutMs)
        : API_REQUEST_TIMEOUT_MS;
    const retries = Number.isInteger(options.retries)
        ? Math.max(0, options.retries)
        : API_REQUEST_RETRIES;
    const retryDelayMs = Number.isFinite(options.retryDelayMs)
        ? Math.max(0, options.retryDelayMs)
        : API_RETRY_DELAY_MS;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const sleepImpl = options.sleepImpl || wait;

    if (typeof fetchImpl !== 'function') {
        throw new Error('当前环境不支持网络请求');
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
            if (!response || !response.ok) {
                throw createHttpError(response ? response.status : 0);
            }
            return await response.json();
        } catch (error) {
            let finalError = error;
            if (error && error.name === 'AbortError') {
                finalError = new Error('网络请求超时');
                finalError.name = 'TimeoutError';
                finalError.retryable = true;
                finalError.cause = error;
            }
            if (attempt < retries && shouldRetryRequest(finalError)) {
                await sleepImpl(retryDelayMs * (2 ** attempt));
                continue;
            }
            throw finalError;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    throw new Error('网络请求失败');
}
