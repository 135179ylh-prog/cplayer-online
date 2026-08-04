import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CPlayerCloudService,
    decidePlaylistSync,
    diffPlaylistContent,
    formatCloudLastSuccessfulAt,
    getPlaylistTrashRemainingDays,
    haveSamePlaylistContent,
    isCloudConflictError,
    isPlaylistTrashExpired,
    isSameCloudMutation,
    makeRecoveredPlaylistName,
    makeCloudOutboxId,
    normalizeCloudConfig,
    normalizePlaylistVersion,
    normalizeRemotePlaylist,
    projectCloudSyncStatus,
    selectRetainedPlaylistVersions,
    toCloudHistoryInput,
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
        purged_at: null,
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

test('playlist conflict diff reports names, additions, metadata and order without private fields', () => {
    const localSong = { ...song, name: '本机歌曲' };
    const localOnly = { id: 8, name: '本机新增', artist: '本机歌手', album: '本机专辑' };
    const remoteOnly = { id: 9, name: '云端新增', artist: '云端歌手', album: '云端专辑' };
    const diff = diffPlaylistContent(
        {
            id: 'user_pl_demo',
            name: '本机歌单',
            songs: [localSong, localOnly]
        },
        remote({
            name: '云端歌单',
            songs: [remoteOnly, { ...song, name: '云端歌曲' }]
        })
    );

    assert.equal(diff.nameChanged, true);
    assert.equal(diff.localSongCount, 2);
    assert.equal(diff.remoteSongCount, 2);
    assert.deepEqual(diff.localOnly.map((item) => item.id), [8]);
    assert.deepEqual(diff.remoteOnly.map((item) => item.id), [9]);
    assert.equal(diff.metadataChanged.length, 1);
    assert.equal(diff.metadataChanged[0].local.name, '本机歌曲');
    assert.equal(diff.metadataChanged[0].remote.name, '云端歌曲');
    assert.equal(diff.orderChanged, false);
    assert.equal(diff.hasChanges, true);
    assert.equal(JSON.stringify(diff).includes('apikey'), false);
});

test('playlist conflict diff detects relative order changes among common songs', () => {
    const first = { id: 1, name: '第一首', artist: '歌手一' };
    const second = { id: 2, name: '第二首', artist: '歌手二' };
    const diff = diffPlaylistContent(
        { id: 'user_pl_demo', name: 'Demo', songs: [first, second] },
        remote({ songs: [second, first] })
    );
    assert.equal(diff.orderChanged, true);
    assert.deepEqual(diff.localOrder.map((item) => item.id), [1, 2]);
    assert.deepEqual(diff.remoteOrder.map((item) => item.id), [2, 1]);
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

test('sync retry acknowledges an already committed identical upsert', () => {
    const local = {
        id: 'user_pl_demo',
        name: 'Demo',
        songs: [song],
        cloudVersion: 0,
        cloudDirty: true
    };
    const outbox = {
        operation: 'upsert',
        playlist: { id: 'user_pl_demo', name: 'Demo', songs: [song] }
    };
    assert.deepEqual(decidePlaylistSync(local, remote({ version: 1 }), outbox), {
        action: 'ack-upsert'
    });
    assert.deepEqual(decidePlaylistSync(
        local,
        remote({ version: 1, name: 'Other' }),
        outbox
    ), { action: 'conflict' });
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
    assert.deepEqual(decidePlaylistSync(null, tombstone, null), { action: 'pull-delete' });
    assert.deepEqual(decidePlaylistSync(
        null,
        tombstone,
        { operation: 'upsert' }
    ), { action: 'none' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 3, cloudDirty: false, deletedAt: Date.now() },
        tombstone,
        null
    ), { action: 'none' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 2, cloudDirty: true },
        tombstone,
        { operation: 'upsert' }
    ), { action: 'conflict' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', name: 'Demo', songs: [song], cloudVersion: 3, cloudDirty: true },
        tombstone,
        { operation: 'restore', expectedVersion: 3 }
    ), { action: 'push', expectedVersion: 3 });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_new', name: 'New', songs: [], cloudVersion: 0, cloudDirty: true, deletedAt: 1 },
        null,
        { operation: 'delete', expectedVersion: 0 }
    ), { action: 'delete', expectedVersion: 0 });
});

test('purge markers cannot be revived and dirty content becomes a recovery copy', () => {
    const purged = remote({
        name: '已永久删除',
        songs: [],
        version: 4,
        deleted_at: '2026-07-23T01:00:00.000Z',
        purged_at: '2026-07-24T01:00:00.000Z'
    });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', name: 'Local', songs: [song], cloudVersion: 3, cloudDirty: true },
        purged,
        { operation: 'restore' }
    ), { action: 'recover-copy' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 3, cloudDirty: false },
        purged,
        null
    ), { action: 'pull-purge' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', cloudVersion: 4, cloudDirty: false, deletedAt: 1, purgedAt: 2 },
        purged,
        null
    ), { action: 'none' });
    assert.deepEqual(decidePlaylistSync(null, purged, { operation: 'purge' }), { action: 'ack-purge' });
    assert.deepEqual(decidePlaylistSync(
        { id: 'user_pl_demo', name: '已永久删除', songs: [], cloudVersion: 3, cloudDirty: true, purgedAt: 1 },
        remote({ version: 3 }),
        { operation: 'purge', expectedVersion: 3 }
    ), { action: 'purge', expectedVersion: 3 });
});

test('restore conflicts keep newer content and use a bounded recovered name', () => {
    const local = {
        id: 'user_pl_demo',
        name: 'Old',
        songs: [song],
        cloudVersion: 1,
        cloudDirty: true
    };
    assert.deepEqual(decidePlaylistSync(local, remote({ name: 'New', version: 2 }), {
        operation: 'restore',
        expectedVersion: 1
    }), { action: 'recover-copy' });
    assert.equal(haveSamePlaylistContent(local, { ...local }), true);
    assert.equal(makeRecoveredPlaylistName('Old'), 'Old（已恢复）');
    assert.equal(makeRecoveredPlaylistName('Old（已恢复）'), 'Old（已恢复）');
    assert.ok(makeRecoveredPlaylistName('x'.repeat(100)).length <= 100);
});

test('history normalization strips private fields and enforces 20 versions or 90 days', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const entries = Array.from({ length: 22 }, (_, index) => ({
        id: 'snapshot-' + index,
        playlistId: 'user_pl_demo',
        name: 'Demo ' + index,
        songs: [{ ...song, apikey: 'private-' + index }],
        reason: index === 0 ? 'restore' : 'edit',
        createdAt: now - index * 60_000
    }));
    entries.push({
        id: 'snapshot-old',
        playlistId: 'user_pl_demo',
        name: 'Old',
        songs: [song],
        createdAt: now - 91 * 86_400_000
    });
    const retained = selectRetainedPlaylistVersions(entries, now);
    assert.equal(retained.length, 20);
    assert.equal(retained[0].id, 'snapshot-0');
    assert.equal(retained.some((entry) => entry.id === 'snapshot-old'), false);
    const payload = toCloudHistoryInput(retained, 'user_pl_demo', now);
    assert.equal(payload.length, 20);
    assert.equal(JSON.stringify(payload).includes('apikey'), false);
    assert.deepEqual(normalizePlaylistVersion(payload[0]), {
        id: 'snapshot-0',
        playlistId: 'user_pl_demo',
        name: 'Demo 0',
        songs: [{
            id: 7,
            name: 'Song',
            artist: 'Artist',
            album: 'Album',
            cover: 'https://example.test/cover.jpg',
            source: 'ChKSz'
        }],
        createdAt: now,
        reason: 'restore',
        snapshotId: 'snapshot-0',
        cloudOwnerId: ''
    });
});

test('history storage ids stay local while cloud snapshot ids round-trip per playlist', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const first = normalizePlaylistVersion({
        id: 'local-owner-a-playlist-a-server-1',
        snapshot_id: 'server-1',
        playlist_id: 'user_pl_a',
        name: 'A',
        songs: [song],
        reason: 'edit',
        created_at: new Date(now).toISOString()
    });
    const duplicate = normalizePlaylistVersion({
        id: 'legacy-server-1',
        snapshotId: 'server-1',
        playlistId: 'user_pl_a',
        name: 'A duplicate',
        songs: [song],
        reason: 'edit',
        createdAt: now - 1000
    });
    const secondPlaylist = normalizePlaylistVersion({
        id: 'local-owner-a-playlist-b-server-1',
        snapshot_id: 'server-1',
        playlist_id: 'user_pl_b',
        name: 'B',
        songs: [song],
        reason: 'edit',
        created_at: new Date(now - 2000).toISOString()
    });

    assert.equal(first.id, 'local-owner-a-playlist-a-server-1');
    assert.equal(first.snapshotId, 'server-1');
    const retained = selectRetainedPlaylistVersions([duplicate, secondPlaylist, first], now);
    assert.deepEqual(retained.map((entry) => entry.id), [first.id, secondPlaylist.id]);
    assert.equal(toCloudHistoryInput([first], 'user_pl_a', now)[0].snapshot_id, 'server-1');
});

test('trash expiry uses a visible 30-day boundary', () => {
    const deletedAt = Date.parse('2026-06-25T12:00:00.000Z');
    assert.equal(getPlaylistTrashRemainingDays(deletedAt, deletedAt), 30);
    assert.equal(getPlaylistTrashRemainingDays(deletedAt, deletedAt + 29 * 86_400_000), 1);
    assert.equal(isPlaylistTrashExpired(deletedAt, deletedAt + 30 * 86_400_000 - 1), false);
    assert.equal(isPlaylistTrashExpired(deletedAt, deletedAt + 30 * 86_400_000), true);
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
    assert.equal(calls[0].name, 'sync_cplayer_playlist_v2');
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
        p_expected_version: 1,
        p_history: []
    });
});
