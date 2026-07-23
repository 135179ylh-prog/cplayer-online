import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CPlayerCloudService,
    decidePlaylistSync,
    formatCloudLastSuccessfulAt,
    isCloudConflictError,
    isSameCloudMutation,
    makeCloudOutboxId,
    normalizeCloudConfig,
    normalizeRemotePlaylist,
    projectCloudSyncStatus,
    toCloudPlaylistInput
} from '../js/cloud-sync.js';

const song = {
    id: 7,
    name: 'Song',
    artist: 'Artist',
    album: 'Album',
    cover: 'https://example.test/cover.jpg',
    source: 'ChKSz',
    apikey: 'must-not-cross-boundary'
};

function remoteRow(overrides = {}) {
    return {
        playlist_id: 'user_pl_demo',
        name: 'Demo',
        songs: [song],
        version: 1,
        updated_at: '2026-07-23T00:00:00.000Z',
        deleted_at: null,
        ...overrides
    };
}

function remote(overrides = {}) {
    return normalizeRemotePlaylist(remoteRow(overrides));
}

test('cloud config accepts public project settings and rejects admin keys', () => {
    assert.deepEqual(normalizeCloudConfig({
        url: 'https://project.supabase.co/',
        publishableKey: 'sb_publishable_runtime_generated_key'
    }), {
        url: 'https://project.supabase.co',
        publishableKey: 'sb_publishable_runtime_generated_key'
    });
    assert.equal(normalizeCloudConfig({
        url: 'https://project.supabase.co',
        publishableKey: 'sb_secret_runtime_generated_key'
    }), null);
    assert.equal(normalizeCloudConfig({
        url: 'https://user:password@project.supabase.co',
        publishableKey: 'runtime_public_key_123456'
    }), null);
    assert.equal(normalizeCloudConfig({
        url: 'http://project.supabase.co',
        publishableKey: 'runtime_public_key_123456'
    }), null);
});

test('cloud status projection uses one honest summary for counts and retry', () => {
    assert.deepEqual(projectCloudSyncStatus({
        state: 'synced',
        signedIn: true,
        pendingCount: 0,
        conflictCount: 0,
        lastSuccessfulAt: 1_000,
        now: 40_000
    }), {
        state: 'synced',
        visualState: 'synced',
        label: '已同步',
        pendingCount: 0,
        conflictCount: 0,
        lastSuccessfulText: '刚刚',
        retrySuggested: false,
        entryLabel: '打开设置，云同步：已同步，0 项待同步，0 个冲突'
    });

    const signedOutPending = projectCloudSyncStatus({
        state: 'signed-out',
        signedIn: false,
        pendingCount: 2,
        conflictCount: 0
    });
    assert.equal(signedOutPending.visualState, 'pending');
    assert.equal(signedOutPending.label, '未登录 · 有待办');
    assert.equal(signedOutPending.retrySuggested, false);
    assert.match(signedOutPending.entryLabel, /2 项待同步/);

    const conflict = projectCloudSyncStatus({
        state: 'pending',
        signedIn: true,
        pendingCount: 3,
        conflictCount: 2
    });
    assert.equal(conflict.visualState, 'conflict');
    assert.equal(conflict.label, '有冲突');
    assert.equal(conflict.retrySuggested, false);

    const error = projectCloudSyncStatus({ state: 'error', signedIn: true });
    assert.equal(error.visualState, 'error');
    assert.equal(error.retrySuggested, true);
});

test('cloud last-success formatting distinguishes missing, minutes and hours', () => {
    assert.equal(formatCloudLastSuccessfulAt(0, 100_000), '尚未成功同步');
    assert.equal(formatCloudLastSuccessfulAt(40_000, 160_000), '2 分钟前');
    assert.equal(formatCloudLastSuccessfulAt(1_000, 7_201_000), '2 小时前');
});

test('cloud playlist payload strips unrelated local fields', () => {
    const payload = toCloudPlaylistInput({
        id: 'user_pl_demo',
        name: 'Demo',
        songs: [song],
        cloudOwnerId: 'owner-a',
        cloudVersion: 4,
        cloudDirty: true,
        apiKey: 'must-not-cross-boundary'
    });
    assert.deepEqual(payload, {
        id: 'user_pl_demo',
        name: 'Demo',
        songs: [{
            id: 7,
            name: 'Song',
            artist: 'Artist',
            album: 'Album',
            cover: 'https://example.test/cover.jpg',
            source: 'ChKSz'
        }]
    });
    assert.equal(JSON.stringify(payload).includes('apikey'), false);
    assert.equal(makeCloudOutboxId('owner-a', 'user_pl_demo'), 'owner-a:user_pl_demo');
});

test('sync decisions preserve local and cloud edits instead of silent overwrite', () => {
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 0, cloudDirty: true },
        null,
        { operation: 'upsert' }
    ), { action: 'push', expectedVersion: 0 });
    assert.deepEqual(decidePlaylistSync(null, remote(), null), { action: 'pull' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 1, cloudDirty: false },
        remote({ version: 1 }),
        null
    ), { action: 'none' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 1, cloudDirty: true },
        remote({ version: 2 }),
        { operation: 'upsert' }
    ), { action: 'conflict' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 1, cloudDirty: false },
        remote({ version: 2 }),
        null
    ), { action: 'pull' });
});

test('remote tombstones pull clean deletes but conflict with dirty local edits', () => {
    const tombstone = remote({
        version: 3,
        deleted_at: '2026-07-23T01:00:00.000Z'
    });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 2, cloudDirty: false },
        tombstone,
        null
    ), { action: 'pull-delete' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 2, cloudDirty: true },
        tombstone,
        { operation: 'upsert' }
    ), { action: 'conflict' });
});

test('cloud conflict errors are normalized from RPC responses', () => {
    assert.equal(isCloudConflictError({ message: 'cplayer_playlist_conflict' }), true);
    assert.equal(isCloudConflictError({ code: 'P0001', details: 'playlist conflict' }), true);
    assert.equal(isCloudConflictError(new Error('network timeout')), false);
});

test('cloud mutation identity does not fall back to a wall-clock timestamp', () => {
    assert.equal(isSameCloudMutation(
        { mutationId: 'm-1', updatedAt: 100 },
        { mutationId: 'm-1', updatedAt: 100 }
    ), true);
    assert.equal(isSameCloudMutation(
        { mutationId: 'm-2', updatedAt: 100 },
        { mutationId: 'm-3', updatedAt: 100 }
    ), false);
    assert.equal(isSameCloudMutation(
        { updatedAt: 100 },
        { updatedAt: 100 }
    ), false);
});

test('cloud service sends only optimistic playlist RPC fields', async () => {
    const calls = [];
    const fakeClient = {
        auth: {
            getSession: async () => ({ data: { session: null }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signInWithPassword: async () => ({ data: { session: null }, error: null })
        },
        rpc: async (name, args) => {
            calls.push({ name, args });
            return { data: [remoteRow({ version: 2 })], error: null };
        },
        from: () => {
            throw new Error('not used in this test');
        }
    };
    const fakeSupabase = {
        createClient: (url, key, options) => {
            assert.equal(url, 'https://project.supabase.co');
            assert.equal(key, 'runtime_public_key_123456');
            assert.equal(typeof options.auth.storage.getItem, 'function');
            return fakeClient;
        }
    };
    const service = new CPlayerCloudService({
        config: { url: 'https://project.supabase.co', publishableKey: 'runtime_public_key_123456' },
        supabase: fakeSupabase,
        storage: { getItem() {}, setItem() {}, removeItem() {} }
    });
    await service.upsertPlaylist({
        id: 'user_pl_demo',
        name: 'Demo',
        songs: [song],
        apiKey: 'must-not-cross-boundary'
    }, 1);
    assert.equal(calls[0].name, 'sync_cplayer_playlist');
    assert.deepEqual(calls[0].args, {
        p_playlist_id: 'user_pl_demo',
        p_name: 'Demo',
        p_songs: [{
            id: 7,
            name: 'Song',
            artist: 'Artist',
            album: 'Album',
            cover: 'https://example.test/cover.jpg',
            source: 'ChKSz'
        }],
        p_expected_version: 1
    });
});
