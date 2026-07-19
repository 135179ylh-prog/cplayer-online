import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyPlaybackQuality,
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

test('classifyPlaybackQuality separates API labels, inference, and unknown streams', () => {
    const master = classifyPlaybackQuality({ level: 'jymaster', bitrate: 128000 });
    assert.equal(master.text, '标注 JyMaster');
    assert.equal(master.source, 'api');
    assert.equal(master.detail, '上游 API 标注为 JyMaster');

    const hiRes = classifyPlaybackQuality({ level: 'hi-res', bitrate: 320000 });
    assert.equal(hiRes.text, '标注 Hi-Res');
    assert.equal(hiRes.source, 'api');

    const high = classifyPlaybackQuality({ bitrate: 320000 });
    assert.equal(high.text, '高音质');
    assert.equal(high.className, 'quality-high');
    assert.equal(high.source, 'inferred');

    const ambiguous = classifyPlaybackQuality({ bitrate: 320 });
    assert.equal(ambiguous.text, '音质未标注');
    assert.equal(ambiguous.source, 'unknown');

    const lossless = classifyPlaybackQuality({ url: 'https://example.test/track.flac' });
    assert.equal(lossless.text, '无损');
    assert.equal(lossless.source, 'inferred');

    const unknown = classifyPlaybackQuality({});
    assert.equal(unknown.text, '音质未标注');
    assert.equal(unknown.className, 'quality-unknown');
    assert.equal(unknown.source, 'unknown');
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
