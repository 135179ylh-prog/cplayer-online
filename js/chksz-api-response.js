/**
 * Decode ChKSz HTTP responses without exposing request details to callers.
 * This module deliberately has no DOM, storage, or credential dependency.
 */

const STATUS_MESSAGES = Object.freeze({
    400: '请求参数不正确',
    401: 'API 鉴权失败',
    402: '请求额度已用尽',
    403: '当前请求无权访问',
    404: '接口或资源不存在',
    408: '请求超时',
    429: '请求过于频繁',
    500: '服务内部异常',
    502: '上游音乐服务异常',
    503: '服务暂时不可用',
    504: '服务响应超时'
});

function normalizeStatus(status) {
    const value = Number(status);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeCode(code, status) {
    if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/.test(code)) return code;
    if (typeof code === 'number' && Number.isFinite(code)) return String(code);
    return status ? `HTTP_${status}` : 'NETWORK_ERROR';
}

export class ChKSzHttpError extends Error {
    constructor(message, status = 0, code = '') {
        super(String(message || '请求失败'));
        this.name = 'ChKSzHttpError';
        this.status = normalizeStatus(status);
        this.code = normalizeCode(code, this.status);
        this.retryable = this.status >= 500 && this.status <= 599;
    }
}

export function friendlyChKSzStatus(status) {
    return STATUS_MESSAGES[normalizeStatus(status)] || '';
}

export function formatChKSzError(error, fallback = '操作失败') {
    const status = normalizeStatus(error?.status);
    const statusText = status ? `HTTP ${status}` : '';
    const friendly = friendlyChKSzStatus(status);
    const detail = typeof error?.message === 'string' ? error.message.trim().slice(0, 160) : '';
    return [...new Set([statusText, friendly, detail].filter(Boolean))].join(' · ') || fallback;
}

/**
 * Parse the response body once. Error responses keep only a short, validated
 * server code; response text, URLs, and query parameters never enter the error.
 */
export async function readChKSzJsonResponse(response, label = '请求') {
    const status = normalizeStatus(response?.status);
    let json;
    try {
        if (!response || typeof response.json !== 'function') throw new TypeError('invalid response');
        json = await response.json();
    } catch (_) {
        if (!response?.ok) {
            throw new ChKSzHttpError(friendlyChKSzStatus(status) || `${label}失败`, status);
        }
        throw new ChKSzHttpError(`${label}返回了无效数据`, status, 'INVALID_RESPONSE');
    }

    if (!response.ok) {
        throw new ChKSzHttpError(friendlyChKSzStatus(status) || `${label}失败`, status, json?.code);
    }
    return json;
}
