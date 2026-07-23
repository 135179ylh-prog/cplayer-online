import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
    closeSettings,
    openLibrary,
    openSettings,
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

function makeRemoteRow(id, name, songs, version = 1, deletedAt = null) {
    return {
        playlist_id: id,
        name,
        songs,
        version,
        updated_at: new Date(Date.now() + version).toISOString(),
        deleted_at: deletedAt
    };
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
            await fulfillJson(route, 200, state.rows);
            return;
        }

        if (url.pathname.endsWith('/rest/v1/rpc/sync_cplayer_playlist')) {
            const body = request.postDataJSON() || {};
            const expected = Number(body.p_expected_version || 0);
            const existing = state.rows.find((row) => row.playlist_id === body.p_playlist_id);
            if ((existing && expected === 0) || (existing && existing.version !== expected)) {
                await fulfillJson(route, 409, { code: 'P0001', message: 'cplayer_playlist_conflict' });
                return;
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

        if (url.pathname.endsWith('/rest/v1/rpc/delete_cplayer_playlist')) {
            const body = request.postDataJSON() || {};
            const existing = state.rows.find((row) => row.playlist_id === body.p_playlist_id);
            if (!existing || existing.version !== Number(body.p_expected_version || 0)) {
                await fulfillJson(route, 409, { code: 'P0001', message: 'cplayer_playlist_conflict' });
                return;
            }
            const row = makeRemoteRow(
                existing.playlist_id,
                existing.name,
                existing.songs,
                existing.version + 1,
                new Date().toISOString()
            );
            state.rows = state.rows.filter((item) => item.playlist_id !== row.playlist_id);
            state.rows.push(row);
            await fulfillJson(route, 200, [row]);
            return;
        }

        if (url.pathname.endsWith('/rest/v1/rpc/delete_cplayer_account')) {
            state.accountDeleted = true;
            state.rows = [];
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
            const request = indexedDB.open('CPlayer5DB', 5);
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
        const request = indexedDB.open('CPlayer5DB', 5);
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

test('playlist deletion writes a cloud tombstone before clearing local pending work', async ({ page }) => {
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
    await closeSettings(page);
    await openLibrary(page);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除歌单「待删除歌单」' }).click();

    await expect.poll(() => mock.rows.find((row) => row.playlist_id === 'user_pl_local')?.deleted_at || null)
        .not.toBeNull();
    await expect.poll(async () => (await readCloudStorage(page)).outbox.length).toBe(0);
    expect((await readCloudStorage(page)).playlist).toBeNull();
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
