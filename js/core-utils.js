/**
 * Small, browser-safe primitives shared by the player and Node tests.
 * Keep this module free of DOM and storage dependencies.
 */

export const API_REQUEST_TIMEOUT_MS = 15000;
export const API_REQUEST_RETRIES = 1;
export const API_RETRY_DELAY_MS = 350;

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
