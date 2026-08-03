import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
    closeSettings,
    openLibrary,
    openSettings,
    readPlaylistVersions,
    readTrashPlaylists,
    readUserPlaylists,
    waitForAppReady
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

const CLOUD_URL = 'https://cloud.example.test';
const TEST_EMAIL = 'user-' + randomUUID() + '@example.test';
const TEST_PASSWORD = 'P-' + randomUUID() + '-pass';
const TEST_USER_ID = 'user-' + randomUUID();

const LOCAL_SONG = {
    id: 990001,
    name: '本地同步歌曲',
    artist: '本地歌手',
    album: '本地专辑',
    cover: '',
    source: 'account-test'
};

const REMOTE_SONG = {
    id: 990002,
    name: '云端同步歌曲',
    artist: '云端歌手',
    album: '云端专辑',
    cover: '',
    source: 'account-test'
};

function base64Url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeUser(userId, email) {
    return {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        identities: [],
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z'
    };
}

function makeSession(userId, email) {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = [
        base64Url({ alg: 'HS256', typ: 'JWT' }),
        base64Url({
            aud: 'authenticated',
            exp: now + 3600,
            iat: now,
            iss: CLOUD_URL + '/auth/v1',
            role: 'authenticated',
            sub: userId,
            email
        }),
        'test-signature'
    ].join('.');
    return {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: 'refresh-' + randomUUID(),
        user: makeUser(userId, email)
    };
}

function makeRemoteRow(id, name, songs, version = 1, deletedAt = null, purgedAt = null) {
    return {
        playlist_id: id,
        name,
        songs,
        version,
        updated_at: new Date(Date.now() + version).toISOString(),
        deleted_at: deletedAt,
        purged_at: purgedAt
    };
}

function canonicalJson(value) {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function sameJson(left, right) {
    return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

async function fulfillJson(route, status, body) {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Cache-Control': 'no-store'
        },
        body: JSON.stringify(body)
    });
}

async function installCloudMock(page, options = {}) {
    const state = {
        rows: Array.isArray(options.rows) ? options.rows.map((row) => ({ ...row })) : [],
        requests: [],
        userId: options.userId || TEST_USER_ID,
        email: options.email || TEST_EMAIL,
        signUpSession: options.signUpSession === true,
        playlistListUnavailable: options.playlistListUnavailable === true,
        history: Array.isArray(options.history) ? options.history.map((row) => ({ ...row })) : [],
        accountDeleted: false
    };
    await page.route(CLOUD_URL + '/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        state.requests.push({
            method: request.method(),
            path: url.pathname,
            query: url.search,
            body: request.postData() || ''
        });
        if (request.method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
                }
            });
            return;
        }

        if (url.pathname.endsWith('/auth/v1/token')) {
            const body = request.postDataJSON() || {};
            if (!body.email && url.searchParams.get('grant_type') !== 'refresh_token') {
                await fulfillJson(route, 400, {
                    error: 'invalid_credentials',
                    error_description: 'invalid login credentials'
                });
                return;
            }
            await fulfillJson(route, 200, makeSession(state.userId, body.email || state.email));
            return;
        }

        if (url.pathname.endsWith('/auth/v1/signup')) {
            const body = request.postDataJSON() || {};
            const user = makeUser(state.userId, body.email || state.email);
            await fulfillJson(route, 200, state.signUpSession
                ? makeSession(state.userId, user.email)
                : { user, session: null });
            return;
        }

        if (url.pathname.endsWith('/auth/v1/recover')) {
            await fulfillJson(route, 200, {});
            return;
        }

        if (url.pathname.endsWith('/auth/v1/user')) {
            await fulfillJson(route, 200, makeUser(state.userId, state.email));
            return;
        }

        if (url.pathname.endsWith('/auth/v1/logout')) {
            await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
            return;
        }

        if (url.pathname.endsWith('/rest/v1/cplayer_playlists') && request.method() === 'GET') {
            if (state.playlistListUnavailable) {
                await fulfillJson(route, 400, { message: 'network timeout' });
                return;
            }
            const filter = url.searchParams.get('purged_at') || '';
            const rows = filter.includes('not.')
                ? state.rows.filter((row) => row.purged_at)
                : state.rows.filter((row) => !row.purged_at);
            await fulfillJson(route, 200, rows);
            return;
        }

        if (url.pathname.endsWith('/rest/v1/cplayer_playlist_versions') && request.method() === 'GET') {
            const filter = url.searchParams.get('playlist_id') || '';
            const playlistId = filter.startsWith('eq.') ? filter.slice(3) : '';
            await fulfillJson(route, 200, state.history
                .filter((row) => !playlistId || row.playlist_id === playlistId)
                .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
                .slice(0, 20));
            return;
        }

        if (url.pathname.endsWith('/rest/v1/rpc/sync_cplayer_playlist') ||
            url.pathname.endsWith('/rest/v1/rpc/sync_cplayer_playlist_v2')) {
            const body = request.postDataJSON() || {};
            const expected = Number(body.p_expected_version || 0);
            const existing = state.rows.find((row) => row.playlist_id === body.p_playlist_id);
            if ((existing && expected === 0) || (existing && existing.version !== expected) || existing?.purged_at) {
                await fulfillJson(route, 409, { code: 'P0001', message: 'cplayer_playlist_conflict' });
                return;
            }
            for (const entry of Array.isArray(body.p_history) ? body.p_history : []) {
                if (!state.history.some((row) => row.playlist_id === body.p_playlist_id && row.snapshot_id === entry.snapshot_id)) {
                    state.history.push({ ...entry, playlist_id: body.p_playlist_id });
                }
            }
            if (existing && !existing.purged_at) {
                const snapshotId = 'server-' + existing.version;
                const alreadyRecoverable = state.history.some((row) =>
                    row.playlist_id === existing.playlist_id && row.name === existing.name &&
                    sameJson(row.songs, existing.songs)
                );
                if (!alreadyRecoverable && !state.history.some((row) =>
                    row.playlist_id === existing.playlist_id && row.snapshot_id === snapshotId)) {
                    state.history.push({
                        playlist_id: existing.playlist_id,
                        snapshot_id: snapshotId,
                        name: existing.name,
                        songs: existing.songs,
                        reason: 'edit',
                        created_at: existing.updated_at
                    });
                }
            }
            const row = makeRemoteRow(
                body.p_playlist_id,
                body.p_name,
                body.p_songs,
                existing ? existing.version + 1 : 1
            );
            state.rows = state.rows.filter((item) => item.playlist_id !== row.playlist_id);
            state.rows.push(row);
            await fulfillJson(route, 200, [row]);
            return;
        }

        if (url.pathname.endsWith('/rest/v1/rpc/delete_cplayer_playlist') ||
            url.pathname.endsWith('/rest/v1/rpc/delete_cplayer_playlist_v2')) {
            const body = request.postDataJSON() || {};
            const existing = state.rows.find((row) => row.playlist_id === body.p_playlist_id);
            const expected = Number(body.p_expected_version || 0);
            if ((existing && existing.version !== expected) || existing?.purged_at || (!existing && expected !== 0)) {
                await fulfillJson(route, 409, { code: 'P0001', message: 'cplayer_playlist_conflict' });
                return;
            }
            for (const entry of Array.isArray(body.p_history) ? body.p_history : []) {
                if (!state.history.some((row) => row.playlist_id === body.p_playlist_id && row.snapshot_id === entry.snapshot_id)) {
                    state.history.push({ ...entry, playlist_id: body.p_playlist_id });
                }
            }
            if (existing && !existing.purged_at) {
                const snapshotId = 'server-' + existing.version;
                const alreadyRecoverable = state.history.some((item) =>
                    item.playlist_id === existing.playlist_id && item.name === existing.name &&
                    sameJson(item.songs, existing.songs)
                );
                if (!alreadyRecoverable && !state.history.some((item) =>
                    item.playlist_id === existing.playlist_id && item.snapshot_id === snapshotId)) {
                    state.history.push({
                        playlist_id: existing.playlist_id,
                        snapshot_id: snapshotId,
                        name: existing.name,
                        songs: existing.songs,
                        reason: 'delete',
                        created_at: existing.updated_at
                    });
                }
            }
            const row = makeRemoteRow(
                body.p_playlist_id,
                body.p_name || existing?.name || '未命名歌单',
                body.p_songs || existing?.songs || [],
                existing ? existing.version + 1 : 1,
                new Date().toISOString()
            );
            state.rows = state.rows.filter((item) => item.playlist_id !== row.playlist_id);
            state.rows.push(row);
            await fulfillJson(route, 200, [row]);
            return;
        }

        if (url.pathname.endsWith('/rest/v1/rpc/purge_cplayer_playlist')) {
            const body = request.postDataJSON() || {};
            const existing = state.rows.find((row) => row.playlist_id === body.p_playlist_id);
            if (!existing || existing.version !== Number(body.p_expected_version || 0) || existing.purged_at) {
                await fulfillJson(route, 409, { code: 'P0001', message: 'cplayer_playlist_conflict' });
                return;
            }
            const now = new Date().toISOString();
            const row = makeRemoteRow(existing.playlist_id, '已永久删除', [], existing.version + 1,
                existing.deleted_at || now, now);
            state.rows = state.rows.filter((item) => item.playlist_id !== row.playlist_id);
            state.rows.push(row);
            state.history = state.history.filter((item) => item.playlist_id !== row.playlist_id);
            await fulfillJson(route, 200, [row]);
            return;
        }

        if (url.pathname.endsWith('/rest/v1/rpc/cleanup_cplayer_playlist_data')) {
            const cutoff = Date.now() - 30 * 86_400_000;
            let cleaned = 0;
            state.rows = state.rows.map((row) => {
                if (!row.deleted_at || row.purged_at || Date.parse(row.deleted_at) > cutoff) return row;
                cleaned += 1;
                const now = new Date().toISOString();
                state.history = state.history.filter((item) => item.playlist_id !== row.playlist_id);
                return makeRemoteRow(row.playlist_id, '已永久删除', [], row.version + 1, row.deleted_at, now);
            });
            await fulfillJson(route, 200, cleaned);
            return;
        }

        if (url.pathname.endsWith('/rest/v1/rpc/delete_cplayer_account')) {
            state.accountDeleted = true;
            state.rows = [];
            state.history = [];
            await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
            return;
        }

        await fulfillJson(route, 404, { error: 'not mocked', path: url.pathname });
    });
    return state;
}

async function setCloudConfig(page) {
    await page.addInitScript(({ url, publishableKey }) => {
        window.CPLAYER_CLOUD_CONFIG = { url, publishableKey };
    }, {
        url: CLOUD_URL,
        publishableKey: 'sb_publishable_' + randomUUID()
    });
}

async function setUnconfiguredCloud(page) {
    await page.addInitScript(() => {
        window.CPLAYER_CLOUD_CONFIG = { url: '', publishableKey: '' };
    });
}

async function seedPlaylist(page, record) {
    await page.goto('/playlist-downloader.html');
    await page.evaluate(async (value) => {
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('CPlayer5DB', 6);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains('playlists')) {
                    database.createObjectStore('playlists', { keyPath: 'id' });
                }
                if (!database.objectStoreNames.contains('lyrics')) {
                    database.createObjectStore('lyrics', { keyPath: 'songId' });
                }
                if (!database.objectStoreNames.contains('images')) {
                    const store = database.createObjectStore('images', { keyPath: 'url' });
                    store.createIndex('timestamp', 'timestamp');
                }
                if (!database.objectStoreNames.contains('cloud_outbox')) {
                    const store = database.createObjectStore('cloud_outbox', { keyPath: 'id' });
                    store.createIndex('ownerId', 'ownerId');
                    store.createIndex('updatedAt', 'updatedAt');
                }
                if (!database.objectStoreNames.contains('playlist_versions')) {
                    const store = database.createObjectStore('playlist_versions', { keyPath: 'id' });
                    store.createIndex('playlistId', 'playlistId');
                    store.createIndex('createdAt', 'createdAt');
                    store.createIndex('cloudOwnerId', 'cloudOwnerId');
                }
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const database = request.result;
                const tx = database.transaction('playlists', 'readwrite');
                tx.objectStore('playlists').put(value);
                tx.oncomplete = () => { database.close(); resolve(); };
                tx.onerror = () => { database.close(); reject(tx.error); };
            };
        });
    }, record);
}

async function readCloudStorage(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('CPlayer5DB', 6);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const tx = database.transaction(['playlists', 'cloud_outbox'], 'readonly');
            const playlists = tx.objectStore('playlists').getAll();
            const outbox = tx.objectStore('cloud_outbox').getAll();
            let rows = [];
            let pending = [];
            playlists.onsuccess = () => { rows = playlists.result || []; };
            outbox.onsuccess = () => { pending = outbox.result || []; };
            tx.oncomplete = () => {
                database.close();
                resolve({
                    playlist: rows.find((row) => row.id === 'user_pl_local') || null,
                    rows,
                    outbox: pending
                });
            };
            tx.onerror = () => { database.close(); reject(tx.error); };
        };
    }));
}

async function openConfiguredApp(page, mockOptions = {}, seed = null) {
    await setCloudConfig(page);
    const mock = await installCloudMock(page, mockOptions);
    if (seed) await seedPlaylist(page, seed);
    await page.goto('/index.html');
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .not.toBe('disabled');
    return mock;
}

async function submitSignIn(page, expectedState = 'synced') {
    await openSettings(page);
    await page.locator('#cloudAccountEmail').fill(TEST_EMAIL);
    await page.locator('#cloudAccountPassword').fill(TEST_PASSWORD);
    await page.locator('#cloudAccountSignInBtn').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe(expectedState);
}

function visibleSettingsTrigger(page) {
    return page.locator('#settingsBtn:visible, #mobileSettingsBtn:visible').first();
}

test('unconfigured cloud keeps local-only account fallback visible', async ({ page }) => {
    await setUnconfiguredCloud(page);
    await page.goto('/index.html');
    await waitForAppReady(page);
    await openSettings(page);
    await expect(page.locator('#cloudAccountStatus')).toContainText('尚未配置');
    await expect(page.locator('#cloudAccountSignInBtn')).toBeDisabled();
});

test('sign-in uploads a local playlist and persists clean cloud metadata', async ({ page }) => {
    const local = {
        id: 'user_pl_local',
        name: '本地收藏',
        songs: [LOCAL_SONG],
        timestamp: Date.now()
    };
    const mock = await openConfiguredApp(page, {}, local);
    await submitSignIn(page);

    const storage = await readCloudStorage(page);
    expect(storage.playlist.cloudOwnerId).toBe(TEST_USER_ID);
    expect(storage.playlist.cloudVersion).toBe(1);
    expect(storage.playlist.cloudDirty).toBe(false);
    expect(storage.outbox).toEqual([]);
    expect(mock.rows[0].playlist_id).toBe('user_pl_local');
    expect(mock.requests.some((request) => request.body.includes('apikey'))).toBe(false);
    await expect(page.locator('#cloudStatusBadge')).toHaveText('已同步');
    await expect(page.locator('#cloudPendingCount')).toHaveText('0');
    await expect(page.locator('#cloudConflictCount')).toHaveText('0');
    await expect(page.locator('#cloudLastSuccessfulAt')).toHaveText('刚刚');
    await expect(visibleSettingsTrigger(page)).toHaveAttribute(
        'aria-label',
        /云同步：已同步，0 项待同步，0 个冲突/
    );
    const lastSuccess = await page.evaluate(() => JSON.parse(localStorage.getItem('cp_cloud_last_success')));
    expect(lastSuccess.ownerId).toBe(TEST_USER_ID);
    expect(Number.isFinite(lastSuccess.at)).toBe(true);
});

test('remote playlist downloads into the local playlist store', async ({ page }) => {
    const row = makeRemoteRow('user_pl_remote', '云端收藏', [REMOTE_SONG], 3);
    const mock = await openConfiguredApp(page, { rows: [row] });
    await submitSignIn(page);

    await expect.poll(async () => (await readUserPlaylists(page))
        .some((item) => item.id === 'user_pl_remote')).toBe(true);
    const downloaded = (await readUserPlaylists(page)).find((item) => item.id === 'user_pl_remote');
    expect(downloaded.name).toBe('云端收藏');
    expect(downloaded.cloudVersion).toBe(3);
    expect(mock.requests.some((request) => request.path.endsWith('/rest/v1/cplayer_playlists'))).toBe(true);
});

test('remote-only trash downloads to a device without the legacy local record and can restore', async ({ page }) => {
    const deletedAt = new Date(Date.now() - 60_000).toISOString();
    const row = makeRemoteRow(
        'user_pl_remote_trash',
        'Remote-only trash',
        [REMOTE_SONG],
        3,
        deletedAt
    );
    const mock = await openConfiguredApp(page, { rows: [row] });
    await submitSignIn(page);

    await expect.poll(async () => (await readTrashPlaylists(page)).length).toBe(1);
    expect((await readTrashPlaylists(page))[0]).toMatchObject({
        id: 'user_pl_remote_trash',
        name: 'Remote-only trash',
        songs: [REMOTE_SONG],
        cloudVersion: 3,
        cloudDirty: false
    });

    await closeSettings(page);
    await openLibrary(page);
    await page.locator('#libraryTrashTab').click();
    await expect(page.locator('#playlistTrashList')).toContainText('Remote-only trash');
    await page.locator('#playlistTrashList button').first().click();

    await expect.poll(() => mock.rows.find((item) => item.playlist_id === 'user_pl_remote_trash')?.deleted_at)
        .toBeNull();
    await expect.poll(async () => (await readUserPlaylists(page))
        .some((item) => item.id === 'user_pl_remote_trash')).toBe(true);
});

test('conflict choice can explicitly keep the cloud copy', async ({ page }) => {
    const local = {
        id: 'user_pl_local',
        name: '本机版本',
        songs: [LOCAL_SONG],
        timestamp: Date.now(),
        cloudOwnerId: TEST_USER_ID,
        cloudVersion: 1,
        cloudDirty: true
    };
    const row = makeRemoteRow('user_pl_local', '云端版本', [REMOTE_SONG], 2);
    await openConfiguredApp(page, { rows: [row] }, local);
    await submitSignIn(page, 'conflict');
    await expect(page.locator('#cloudAccountConflict')).toBeVisible();
    await expect(page.locator('#cloudStatusBadge')).toHaveText('有冲突');
    await expect(page.locator('#cloudConflictCount')).toHaveText('1');
    await expect(page.locator('#cloudAccountConflictPosition')).toHaveText('1 / 1');
    const diff = page.locator('#cloudAccountConflictDiff');
    await expect(diff).toContainText('名称不同');
    await expect(diff).toContainText('本机版本');
    await expect(diff).toContainText('云端版本');
    await expect(diff).toContainText('本地同步歌曲');
    await expect(diff).toContainText('云端同步歌曲');
    await page.locator('#cloudAccountUseCloudBtn').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('synced');
    const storage = await readCloudStorage(page);
    expect(storage.playlist.name).toBe('云端版本');
    expect(storage.outbox).toEqual([]);
    await expect(page.locator('#cloudConflictCount')).toHaveText('0');
});

test('registration and password recovery show clear feedback', async ({ page }) => {
    const mock = await openConfiguredApp(page, { signUpSession: false });
    await openSettings(page);
    await page.locator('#cloudAccountEmail').fill(TEST_EMAIL);
    await page.locator('#cloudAccountPassword').fill(TEST_PASSWORD);
    await page.locator('#cloudAccountSignUpBtn').click();
    await expect(page.locator('#cloudAccountStatus')).toContainText('验证');
    await page.locator('#cloudAccountResetBtn').click();
    await expect(page.locator('#cloudAccountStatus')).toContainText('重置邮件');
    expect(mock.requests.some((request) => request.path.endsWith('/auth/v1/signup'))).toBe(true);
    expect(mock.requests.some((request) => request.path.endsWith('/auth/v1/recover'))).toBe(true);
});

test('another account does not sync a foreign local playlist', async ({ page }) => {
    const foreign = {
        id: 'user_pl_local',
        name: '另一账号歌单',
        songs: [LOCAL_SONG],
        timestamp: Date.now(),
        cloudOwnerId: 'foreign-' + randomUUID(),
        cloudVersion: 4,
        cloudDirty: true
    };
    await openConfiguredApp(page, {}, foreign);
    await submitSignIn(page);
    await closeSettings(page);
    await openLibrary(page);
    await expect(page.locator('#myPlaylistsList')).not.toContainText('另一账号歌单');
});

test('same-id foreign playlist is never overwritten by a remote row', async ({ page }) => {
    const foreign = {
        id: 'user_pl_collision',
        name: '其他账号的本机歌单',
        songs: [LOCAL_SONG],
        timestamp: Date.now(),
        cloudOwnerId: 'foreign-' + randomUUID(),
        cloudVersion: 2,
        cloudDirty: false
    };
    const remote = makeRemoteRow('user_pl_collision', '当前账号云端歌单', [REMOTE_SONG], 3);
    await openConfiguredApp(page, { rows: [remote] }, foreign);
    await submitSignIn(page, 'error');
    const storage = await readCloudStorage(page);
    expect(storage.rows.find((row) => row.id === 'user_pl_collision')?.name)
        .toBe('其他账号的本机歌单');
    await expect(page.locator('#cloudAccountStatus')).toContainText('未覆盖本地数据');
});

test('offline playlist edit stays pending and syncs after reconnect', async ({ page, context }) => {
    const mock = await openConfiguredApp(page);
    await submitSignIn(page);
    await closeSettings(page);
    await openLibrary(page);

    await context.setOffline(true);
    try {
        await page.locator('#myNewPlaylistName').fill('离线新建歌单');
        await page.locator('#myCreatePlaylistBtn').click();
        await expect(page.locator('#myPlaylistsList')).toContainText('离线新建歌单');
        await expect(page.locator('html')).toHaveAttribute('data-cplayer-cloud-state', 'pending');
        await expect(page.locator('html')).toHaveAttribute('data-cplayer-cloud-pending', '1');
        await expect(visibleSettingsTrigger(page)).toHaveAttribute('aria-label', /1 项待同步/);
        expect((await readCloudStorage(page)).outbox).toHaveLength(1);
    } finally {
        await context.setOffline(false);
    }

    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('synced');
    await expect(page.locator('html')).toHaveAttribute('data-cplayer-cloud-pending', '0');
    expect((await readCloudStorage(page)).outbox).toEqual([]);
    expect(mock.rows.some((row) => row.name === '离线新建歌单')).toBe(true);
});

test('health report becomes stale after a new pending edit and refreshes safely', async ({ page, context }) => {
    await openConfiguredApp(page);
    await submitSignIn(page);

    await page.locator('#cloudHealthCheckBtn').click();
    await expect(page.locator('#cloudHealthCheckStatus')).toContainText('检查完成');
    await expect(page.locator('#cloudHealthCheckFreshness')).toBeHidden();
    await expect(page.locator('#cloudHealthCheckExportBtn')).toBeEnabled();

    await closeSettings(page);
    await openLibrary(page);
    await context.setOffline(true);
    try {
        await page.locator('#myNewPlaylistName').fill('健康检查过期测试');
        await page.locator('#myCreatePlaylistBtn').click();
        await expect(page.locator('#myPlaylistsList')).toContainText('健康检查过期测试');
        await expect(page.locator('html')).toHaveAttribute('data-cplayer-cloud-pending', '1');
        await page.locator('#closeMyPlaylistsBtn').click();
        await expect(page.locator('#myPlaylistsModal')).toBeHidden();

        await openSettings(page);
        await expect(page.locator('#cloudHealthCheckFreshness')).toBeVisible();
        await expect(page.locator('#cloudHealthCheckFreshness')).toContainText('过期');
        await expect(page.locator('#cloudHealthCheckExportBtn')).toBeDisabled();

        await page.locator('#cloudHealthCheckBtn').click();
        await expect(page.locator('#cloudHealthCheckStatus')).toContainText('检查完成');
        await expect(page.locator('#cloudHealthCheckFreshness')).toBeHidden();
        await expect(page.locator('#cloudHealthCheckExportBtn')).toBeEnabled();
        const report = await page.evaluate(() => window.getCloudHealthReport());
        expect(report.stale).toBe(false);
        expect(report.items.find((item) => item.id === 'cloud').detail).toContain('1 项');
    } finally {
        await context.setOffline(false);
    }
});

test('signed-in session restores after reload and local sign-out clears it', async ({ page }) => {
    await openConfiguredApp(page);
    await submitSignIn(page);
    const firstLastSuccess = await page.evaluate(() => JSON.parse(localStorage.getItem('cp_cloud_last_success')));
    expect(firstLastSuccess.ownerId).toBe(TEST_USER_ID);
    await page.reload();
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('synced');
    await openSettings(page);
    await expect(page.locator('#cloudAccountUserEmail')).toHaveText(TEST_EMAIL);
    await expect(page.locator('#cloudLastSuccessfulAt')).not.toHaveText('尚未成功同步');
    await page.locator('#cloudAccountSignOutBtn').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('signed-out');
    const sessionKeys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('sb-')));
    expect(sessionKeys).toEqual([]);
});

test('sync error keeps pending data visible and succeeds through retry', async ({ page }) => {
    const local = {
        id: 'user_pl_local',
        name: '等待重试',
        songs: [LOCAL_SONG],
        timestamp: Date.now()
    };
    const mock = await openConfiguredApp(page, { playlistListUnavailable: true }, local);
    await submitSignIn(page, 'error');

    await expect(page.locator('#cloudStatusBadge')).toHaveText('同步出错');
    await expect(page.locator('#cloudLastError')).toBeVisible();
    await expect(page.locator('#cloudLastError')).toContainText('最近错误');
    await expect(page.locator('#cloudAccountSyncBtnLabel')).toHaveText('重试同步');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudPending))
        .toBe('1');
    expect((await readCloudStorage(page)).outbox).toHaveLength(1);

    await page.reload();
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('error');
    await openSettings(page);
    await expect(page.locator('#cloudStatusBadge')).toHaveText('同步出错');
    await expect(page.locator('#cloudLastError')).toBeVisible();
    await expect(page.locator('#cloudLastError')).toContainText('最近错误');
    await expect(page.locator('#cloudAccountSyncBtnLabel')).toHaveText('重试同步');
    await page.locator('#cloudHealthCheckBtn').click();
    await expect(page.locator('#cloudHealthCheckStatus')).toContainText('检查完成');
    const errorReport = await page.evaluate(() => window.getCloudHealthReport());
    const storedError = await page.evaluate(() => JSON.parse(localStorage.getItem('cp_cloud_last_error')));
    expect(errorReport.items.find((item) => item.id === 'cloud').lastError).toBe(storedError.message);
    expect(JSON.stringify(errorReport)).not.toContain('apikey');

    mock.playlistListUnavailable = false;
    await page.locator('#cloudAccountSyncBtn').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('synced');
    await expect(page.locator('#cloudLastError')).toBeHidden();
    await expect(page.locator('#cloudAccountSyncBtnLabel')).toHaveText('立即同步');
    await expect(page.locator('#cloudPendingCount')).toHaveText('0');
    expect((await readCloudStorage(page)).outbox).toEqual([]);
    expect(mock.rows.some((row) => row.name === '等待重试')).toBe(true);
});

test('pending queue lists concrete playlists and supports single then all retry', async ({ page, context }) => {
    const mock = await openConfiguredApp(page);
    await submitSignIn(page);
    await closeSettings(page);
    await openLibrary(page);

    mock.playlistListUnavailable = true;
    await page.locator('#myNewPlaylistName').fill('单项重试歌单');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect.poll(async () => (await readUserPlaylists(page))
        .map((item) => item.name)).toEqual(expect.arrayContaining(['单项重试歌单']));
    await page.locator('#myNewPlaylistName').fill('全部重试歌单');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect.poll(async () => (await readUserPlaylists(page))
        .map((item) => item.name)).toEqual(expect.arrayContaining(['全部重试歌单']));
    await expect(page.locator('#myPlaylistsList')).toContainText('单项重试歌单');
    await expect(page.locator('#myPlaylistsList')).toContainText('全部重试歌单');
    await expect(page.locator('html')).toHaveAttribute('data-cplayer-cloud-pending', '2');
    expect((await readCloudStorage(page)).outbox).toHaveLength(2);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('error');

    await page.locator('#closeMyPlaylistsBtn').click();
    await expect(page.locator('#myPlaylistsModal')).toBeHidden();
    await openSettings(page);
    await expect(page.locator('#cloudPendingQueue')).toBeVisible();
    await expect(page.locator('#cloudPendingList')).toContainText('单项重试歌单');
    await expect(page.locator('#cloudPendingList')).toContainText('全部重试歌单');
    await expect(page.locator('#cloudPendingList button')).toHaveCount(2);
    await expect(page.locator('#cloudRetryAllBtn')).toBeEnabled();
    await context.setOffline(true);
    await expect(page.locator('#cloudPendingList button').first()).toBeDisabled();
    await expect(page.locator('#cloudRetryAllBtn')).toBeDisabled();
    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('error');

    mock.playlistListUnavailable = false;
    await page.getByRole('button', { name: '重试歌单「单项重试歌单」' }).click();
    await expect.poll(async () => (await readCloudStorage(page)).outbox.length).toBe(1);
    await expect(page.locator('#cloudPendingList')).toContainText('全部重试歌单');
    await expect(page.locator('#cloudPendingList')).not.toContainText('单项重试歌单');
    await expect(page.locator('#cloudPendingList button')).toHaveCount(1);
    await expect(page.locator('#cloudPendingQueue')).toBeVisible();

    await page.locator('#cloudRetryAllBtn').click();
    await expect.poll(async () => (await readCloudStorage(page)).outbox.length).toBe(0);
    await expect(page.locator('#cloudPendingQueue')).toBeHidden();
    await expect(page.locator('#cloudPendingCount')).toHaveText('0');
    expect(mock.rows.some((row) => row.name === '单项重试歌单')).toBe(true);
    expect(mock.rows.some((row) => row.name === '全部重试歌单')).toBe(true);
});

test('foreign account sync error is not shown to the current account', async ({ page }) => {
    await setCloudConfig(page);
    await installCloudMock(page);
    await page.addInitScript(() => {
        localStorage.setItem('cp_cloud_last_error', JSON.stringify({
            ownerId: 'foreign-owner',
            at: Date.now(),
            message: '其他账号的同步错误'
        }));
    });
    await page.goto('/index.html');
    await waitForAppReady(page);
    await submitSignIn(page);

    await expect(page.locator('#cloudLastError')).toBeHidden();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cp_cloud_last_error')));
    expect(stored).toMatchObject({
        ownerId: 'foreign-owner',
        message: '其他账号的同步错误'
    });
});

test('trash restore works offline and permanent delete converges to a content-free marker', async ({ page, context }) => {
    const local = {
        id: 'user_pl_local',
        name: '待删除歌单',
        songs: [LOCAL_SONG],
        timestamp: Date.now(),
        cloudOwnerId: TEST_USER_ID,
        cloudVersion: 1,
        cloudDirty: false
    };
    const remote = makeRemoteRow('user_pl_local', '待删除歌单', [LOCAL_SONG], 1);
    const mock = await openConfiguredApp(page, { rows: [remote] }, local);
    await submitSignIn(page);
    const foreignHistoryOwner = 'foreign-history-' + randomUUID();
    await page.evaluate(({ foreignHistoryOwner, currentOwner, localSong, remoteSong }) => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 6);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const database = open.result;
            const tx = database.transaction('playlist_versions', 'readwrite');
            const store = tx.objectStore('playlist_versions');
            store.put({
                id: 'own-history-before-purge',
                playlistId: 'user_pl_local',
                name: '本账号历史',
                songs: [localSong],
                createdAt: Date.now() - 2000,
                reason: 'edit',
                cloudOwnerId: currentOwner
            });
            store.put({
                id: 'foreign-history-must-survive',
                playlistId: 'user_pl_local',
                name: '其他账号历史',
                songs: [remoteSong],
                createdAt: Date.now() - 1000,
                reason: 'edit',
                cloudOwnerId: foreignHistoryOwner
            });
            tx.oncomplete = () => { database.close(); resolve(); };
            tx.onerror = () => { database.close(); reject(tx.error); };
        };
    }), {
        foreignHistoryOwner,
        currentOwner: TEST_USER_ID,
        localSong: LOCAL_SONG,
        remoteSong: REMOTE_SONG
    });
    await closeSettings(page);
    await openLibrary(page);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除歌单「待删除歌单」' }).click();

    await expect.poll(() => mock.rows.find((row) => row.playlist_id === 'user_pl_local')?.deleted_at || null)
        .not.toBeNull();
    await expect.poll(async () => (await readCloudStorage(page)).outbox.length).toBe(0);
    const stored = (await readCloudStorage(page)).playlist;
    expect(stored.name).toBe('待删除歌单');
    expect(stored.songs).toEqual([LOCAL_SONG]);
    expect(stored.deletedAt).toBeGreaterThan(0);
    expect(stored.purgedAt).toBe(0);
    expect(await readTrashPlaylists(page)).toHaveLength(1);

    await page.getByRole('tab', { name: /回收站/ }).click();
    await context.setOffline(true);
    try {
        await page.getByRole('button', { name: '恢复歌单「待删除歌单」' }).click();
        await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(1);
        await expect(page.locator('html')).toHaveAttribute('data-cplayer-cloud-pending', '1');
    } finally {
        await context.setOffline(false);
    }
    await expect.poll(() => {
        const row = mock.rows.find((item) => item.playlist_id === 'user_pl_local');
        return row ? row.deleted_at : 'missing';
    })
        .toBeNull();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState)).toBe('synced');

    await page.getByRole('tab', { name: /我的歌单/ }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除歌单「待删除歌单」' }).click();
    await expect.poll(() => mock.rows.find((row) => row.playlist_id === 'user_pl_local')?.deleted_at || null)
        .not.toBeNull();
    await page.getByRole('tab', { name: /回收站/ }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '永久删除歌单「待删除歌单」' }).click();
    await expect.poll(() => mock.rows.find((row) => row.playlist_id === 'user_pl_local')?.purged_at || null)
        .not.toBeNull();
    const purgedRemote = mock.rows.find((row) => row.playlist_id === 'user_pl_local');
    expect(purgedRemote.name).toBe('已永久删除');
    expect(purgedRemote.songs).toEqual([]);
    expect(mock.history.filter((entry) => entry.playlist_id === 'user_pl_local')).toEqual([]);
    await expect.poll(async () => (await readCloudStorage(page)).outbox.length).toBe(0);
    const purgedLocal = (await readCloudStorage(page)).playlist;
    expect(purgedLocal.name).toBe('已永久删除');
    expect(purgedLocal.songs).toEqual([]);
    expect(purgedLocal.purgedAt).toBeGreaterThan(0);
    const retainedLocalHistory = await readPlaylistVersions(page, 'user_pl_local');
    expect(retainedLocalHistory).toHaveLength(1);
    expect(retainedLocalHistory[0]).toMatchObject({
        id: 'foreign-history-must-survive',
        cloudOwnerId: foreignHistoryOwner
    });
});

test('playlist history uploads safely and can be pulled on demand by another device state', async ({ page }) => {
    const local = {
        id: 'user_pl_local',
        name: '跨设备历史',
        songs: [LOCAL_SONG],
        timestamp: Date.now(),
        cloudOwnerId: TEST_USER_ID,
        cloudVersion: 1,
        cloudDirty: false
    };
    const remote = makeRemoteRow('user_pl_local', '跨设备历史', [LOCAL_SONG], 1);
    const mock = await openConfiguredApp(page, { rows: [remote] }, local);
    await submitSignIn(page);
    await closeSettings(page);
    await openLibrary(page);

    await page.evaluate((song) => window.openAddToPlaylistModal(song), REMOTE_SONG);
    await page.getByRole('button', { name: /跨设备历史 \d+ 首 加入/ }).click();
    await expect.poll(async () => (await readUserPlaylists(page))[0].songs.length).toBe(2);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState)).toBe('synced');
    await expect.poll(() => mock.history.filter((entry) => entry.playlist_id === 'user_pl_local').length).toBe(1);
    expect(JSON.stringify(mock.history)).not.toContain('apikey');

    await page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 6);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const database = open.result;
            const tx = database.transaction('playlist_versions', 'readwrite');
            tx.objectStore('playlist_versions').clear();
            tx.oncomplete = () => { database.close(); resolve(); };
            tx.onerror = () => { database.close(); reject(tx.error); };
        };
    }));
    expect(await readPlaylistVersions(page, 'user_pl_local')).toEqual([]);

    await page.getByRole('button', { name: '管理歌单「跨设备历史」' }).click();
    await page.getByRole('button', { name: '历史版本' }).click();
    await expect(page.locator('#playlistHistoryList button')).toHaveCount(1);
    await page.locator('#playlistHistoryList button').click();
    await expect(page.locator('#playlistHistoryPreview')).toContainText('本地同步歌曲');
    await expect.poll(async () => (await readPlaylistVersions(page, 'user_pl_local')).length).toBe(1);
});

test('remote server snapshot ids remain isolated across different playlists', async ({ page }) => {
    const firstLocal = {
        id: 'user_pl_local',
        name: '历史隔离甲',
        songs: [LOCAL_SONG],
        timestamp: Date.now(),
        cloudOwnerId: TEST_USER_ID,
        cloudVersion: 1,
        cloudDirty: false
    };
    const firstRemote = makeRemoteRow('user_pl_local', '历史隔离甲', [LOCAL_SONG], 1);
    const secondRemote = makeRemoteRow('user_pl_second', '历史隔离乙', [REMOTE_SONG], 1);
    const createdAt = new Date(Date.now() - 10_000).toISOString();
    await openConfiguredApp(page, {
        rows: [firstRemote, secondRemote],
        history: [
            {
                playlist_id: 'user_pl_local',
                snapshot_id: 'server-1',
                name: '甲的旧版本',
                songs: [LOCAL_SONG],
                reason: 'edit',
                created_at: createdAt
            },
            {
                playlist_id: 'user_pl_second',
                snapshot_id: 'server-1',
                name: '乙的旧版本',
                songs: [REMOTE_SONG],
                reason: 'edit',
                created_at: createdAt
            }
        ]
    }, firstLocal);
    await submitSignIn(page);
    await closeSettings(page);
    await openLibrary(page);

    await page.getByRole('button', { name: '管理歌单「历史隔离甲」' }).click();
    await page.getByRole('button', { name: '历史版本' }).click();
    await expect(page.locator('#playlistHistoryList button')).toHaveCount(1);
    await page.locator('#closePlaylistHistoryBtn').click();
    await page.locator('#closePlaylistDetailBtn').click();

    await page.getByRole('button', { name: '管理歌单「历史隔离乙」' }).click();
    await page.getByRole('button', { name: '历史版本' }).click();
    await expect(page.locator('#playlistHistoryList button')).toHaveCount(1);

    const firstHistory = await readPlaylistVersions(page, 'user_pl_local');
    const secondHistory = await readPlaylistVersions(page, 'user_pl_second');
    expect(firstHistory).toHaveLength(1);
    expect(secondHistory).toHaveLength(1);
    expect(firstHistory[0].snapshotId).toBe('server-1');
    expect(secondHistory[0].snapshotId).toBe('server-1');
    expect(firstHistory[0].id).not.toBe(secondHistory[0].id);
});

test('account deletion removes cloud state and retains a device-local playlist', async ({ page }) => {
    const local = {
        id: 'user_pl_local',
        name: '注销后保留',
        songs: [LOCAL_SONG],
        timestamp: Date.now(),
        cloudOwnerId: TEST_USER_ID,
        cloudVersion: 1,
        cloudDirty: false
    };
    const remote = makeRemoteRow('user_pl_local', '注销后保留', [LOCAL_SONG], 1);
    const mock = await openConfiguredApp(page, { rows: [remote] }, local);
    await submitSignIn(page);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#cloudAccountDeleteBtn').click();

    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cplayerCloudState))
        .toBe('signed-out');
    expect(mock.accountDeleted).toBe(true);
    const storage = await readCloudStorage(page);
    expect(storage.playlist.name).toBe('注销后保留');
    expect(storage.playlist.cloudOwnerId).toBeUndefined();
    expect(storage.playlist.cloudVersion).toBeUndefined();
    expect(storage.outbox).toEqual([]);
});
