import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fetchJsonWithRetry,
    normalizeSongObject,
    shouldRetryRequest
} from '../js/core-utils.js';

test('normalizeSongObject handles primitive and API-shaped songs', () => {
    assert.deepEqual(normalizeSongObject(123), {
        id: 123,
        name: '歌曲 ID: 123',
        artist: '未知艺术家',
        cover: '',
        album: '',
        source: 'Search'
    });

    const song = normalizeSongObject({
        id: '7',
        name: 'Song',
        artists: [{ name: 'A' }, { name: 'B' }],
        album: { name: 'Album' },
        picUrl: 'https://example.test/cover.jpg',
        source: 'ChKSz'
    });
    assert.equal(song.artist, 'A, B');
    assert.equal(song.album, 'Album');
    assert.equal(song.cover, 'https://example.test/cover.jpg');
});

test('fetchJsonWithRetry retries a transient server error once', async () => {
    let calls = 0;
    const delays = [];
    const result = await fetchJsonWithRetry('/api', {
        retries: 1,
        retryDelayMs: 5,
        sleepImpl: async (ms) => delays.push(ms),
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return { ok: false, status: 503 };
            return { ok: true, json: async () => ({ ok: true }) };
        }
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [5]);
});

test('fetchJsonWithRetry does not retry client errors', async () => {
    let calls = 0;
    await assert.rejects(() => fetchJsonWithRetry('/api', {
        retries: 2,
        sleepImpl: async () => assert.fail('client errors must not sleep'),
        fetchImpl: async () => {
            calls += 1;
            return { ok: false, status: 404 };
        }
    }), /网络请求失败 \(404\)/);
    assert.equal(calls, 1);
});

test('network TypeError is retryable but malformed JSON is not', async () => {
    assert.equal(shouldRetryRequest(new TypeError('offline')), true);
    assert.equal(shouldRetryRequest(new SyntaxError('bad json')), false);
});
