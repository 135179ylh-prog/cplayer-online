import { test, expect } from '@playwright/test';
import { openLibrary, openSettings, waitForAppReady } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

const DB_NAME = 'CPlayer5DB';
const DB_VERSION = 5;
const HARNESS_PATH = '/__cplayer_storage_harness__.html';

const WINNER_SONG = {
    id: 880001,
    name: '并发胜出歌曲',
    artist: '存储测试歌手甲',
    cover: '',
    album: '存储测试专辑',
    source: 'Storage test'
};

const STALE_SONG = {
    id: 880002,
    name: '过期页面歌曲',
    artist: '存储测试歌手乙',
    cover: '',
    album: '存储测试专辑',
    source: 'Storage test'
};

const RECOVERY_SONG = {
    id: 880005,
    name: '配额恢复歌曲',
    artist: '存储测试歌手丙',
    cover: '',
    album: '存储测试专辑',
    source: 'Storage test'
};

const REMOTE_PLAYLIST_ID = '987654';
const REMOTE_PLAYLIST_SONGS = [{
    id: 880006,
    name: '在线歌单缓存降级歌曲',
    ar: [{ name: '在线歌手' }],
    al: { name: '在线专辑', picUrl: '' }
}];

const LOCAL_PLAYLIST_TRACKS = [{
    id: 880007,
    name: '内置歌单版本续写歌曲',
    artists: '内置歌单歌手',
    album: '内置歌单专辑',
    picUrl: ''
}];

const PROTECTED_QUEUE = {
    id: 'current_queue',
    songs: [{
        id: 880003,
        name: '受保护队列歌曲',
        artist: '队列歌手',
        cover: '',
        album: '队列专辑',
        source: 'Storage seed'
    }],
    currentIndex: 0,
    playMode: 'sequence',
    revision: 7,
    writerId: 'storage-seed-writer',
    timestamp: 1_750_000_000_000,
    reason: 'storage_seed'
};

const PROTECTED_USER_PLAYLIST = {
    id: 'user_pl_storage_proof',
    name: '不可淘汰歌单',
    songs: [{
        id: 880004,
        name: '受保护歌单歌曲',
        artist: '歌单歌手',
        cover: '',
        album: '歌单专辑',
        source: 'Storage seed'
    }],
    timestamp: 1_750_000_000_001
};

async function openStorageHarness(page) {
    await page.route(`**${HARNESS_PATH}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><body data-storage-harness="true"></body></html>'
        });
    });
    await page.goto(HARNESS_PATH);
    await expect(page.locator('body')).toHaveAttribute('data-storage-harness', 'true');
}

async function openTestDatabase(page, version, { hold = false } = {}) {
    return page.evaluate(({ databaseName, targetVersion, keepOpen }) => new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, targetVersion);
        request.onerror = () => reject(request.error || new Error('test database open failed'));
        request.onblocked = () => reject(new Error(`test database v${targetVersion} open was blocked`));
        request.onupgradeneeded = () => {
            const database = request.result;
            const tx = request.transaction;

            let playlistStore;
            if (!database.objectStoreNames.contains('playlists')) {
                playlistStore = database.createObjectStore('playlists', { keyPath: 'id' });
            } else {
                playlistStore = tx.objectStore('playlists');
            }
            if (!playlistStore.indexNames.contains('timestamp')) {
                playlistStore.createIndex('timestamp', 'timestamp');
            }

            if (!database.objectStoreNames.contains('lyrics')) {
                database.createObjectStore('lyrics', { keyPath: 'songId' });
            }

            let imageStore;
            if (!database.objectStoreNames.contains('images')) {
                imageStore = database.createObjectStore('images', { keyPath: 'url' });
            } else {
                imageStore = tx.objectStore('images');
            }
            if (targetVersion >= 4 && !imageStore.indexNames.contains('timestamp')) {
                imageStore.createIndex('timestamp', 'timestamp');
            }

            if (targetVersion >= 5) {
                let outboxStore;
                if (!database.objectStoreNames.contains('cloud_outbox')) {
                    outboxStore = database.createObjectStore('cloud_outbox', { keyPath: 'id' });
                } else {
                    outboxStore = tx.objectStore('cloud_outbox');
                }
                if (!outboxStore.indexNames.contains('ownerId')) {
                    outboxStore.createIndex('ownerId', 'ownerId');
                }
                if (!outboxStore.indexNames.contains('updatedAt')) {
                    outboxStore.createIndex('updatedAt', 'updatedAt');
                }
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            const result = {
                version: database.version,
                stores: Array.from(database.objectStoreNames)
            };
            if (keepOpen) {
                window.__cplayerHeldStorageDatabases = window.__cplayerHeldStorageDatabases || [];
                window.__cplayerHeldStorageDatabases.push(database);
            } else {
                database.close();
            }
            resolve(result);
        };
    }), { databaseName: DB_NAME, targetVersion: version, keepOpen: hold });
}

async function closeHeldDatabases(page) {
    await page.evaluate(() => {
        for (const database of window.__cplayerHeldStorageDatabases || []) database.close();
        window.__cplayerHeldStorageDatabases = [];
    });
}

async function readStorageSnapshot(page) {
    return page.evaluate((databaseName) => new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onerror = () => reject(request.error || new Error('snapshot database open failed'));
        request.onsuccess = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('playlists') ||
                !database.objectStoreNames.contains('images') ||
                !database.objectStoreNames.contains('cloud_outbox')) {
                database.close();
                reject(new Error('storage schema is incomplete'));
                return;
            }

            const tx = database.transaction(['playlists', 'images'], 'readonly');
            const playlistRequest = tx.objectStore('playlists').getAll();
            const imageRequest = tx.objectStore('images').getAll();
            let playlists = [];
            let images = [];
            playlistRequest.onsuccess = () => { playlists = playlistRequest.result || []; };
            imageRequest.onsuccess = () => { images = imageRequest.result || []; };
            tx.oncomplete = () => {
                const queue = playlists.find((record) => record && record.id === 'current_queue') || null;
                const users = playlists
                    .filter((record) => record && String(record.id).startsWith('user_pl_'))
                    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
                const remote = playlists
                    .filter((record) => record && record.id !== 'current_queue' &&
                        !String(record.id).startsWith('user_pl_'))
                    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
                const imageIndexes = Array.from(
                    database.transaction('images', 'readonly').objectStore('images').indexNames
                );
                const snapshot = {
                    version: database.version,
                    imageIndexes,
                    imageCount: images.length,
                    imageUrls: images.map((record) => record.url).sort(),
                    remoteCount: remote.length,
                    remote,
                    queue,
                    users
                };
                database.close();
                resolve(snapshot);
            };
            tx.onerror = () => {
                const error = tx.error || new Error('snapshot transaction failed');
                database.close();
                reject(error);
            };
            tx.onabort = () => {
                const error = tx.error || new Error('snapshot transaction aborted');
                database.close();
                reject(error);
            };
        };
    }), DB_NAME);
}

async function seedTransientCaches(page, {
    imageCount,
    remoteCount,
    queue = null,
    users = []
}) {
    return page.evaluate(({ databaseName, imagesToSeed, remoteToSeed, queueRecord, userRecords }) => (
        new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName);
            request.onerror = () => reject(request.error || new Error('seed database open failed'));
            request.onsuccess = () => {
                const database = request.result;
                const tx = database.transaction(['playlists', 'images'], 'readwrite');
                const playlistStore = tx.objectStore('playlists');
                const imageStore = tx.objectStore('images');

                if (queueRecord) playlistStore.put(queueRecord);
                for (const userRecord of userRecords) playlistStore.put(userRecord);
                for (let index = 0; index < remoteToSeed; index += 1) {
                    playlistStore.put({
                        id: `remote_storage_${String(index).padStart(3, '0')}`,
                        songs: [],
                        timestamp: 10_000 + index
                    });
                }
                for (let index = 0; index < imagesToSeed; index += 1) {
                    imageStore.put({
                        url: `https://storage.invalid/image-${String(index).padStart(3, '0')}.jpg`,
                        data: `data:image/jpeg;base64,storage-${index}`,
                        timestamp: 20_000 + index
                    });
                }

                // These requests are queued after every put in the same real
                // transaction, so they prove the overflow was actually seeded.
                const imageCountRequest = imageStore.count();
                const playlistRequest = playlistStore.getAll();
                let seededImageCount = 0;
                let seededRemoteCount = 0;
                imageCountRequest.onsuccess = () => { seededImageCount = imageCountRequest.result; };
                playlistRequest.onsuccess = () => {
                    seededRemoteCount = (playlistRequest.result || []).filter((record) => (
                        record && record.id !== 'current_queue' &&
                        !String(record.id).startsWith('user_pl_')
                    )).length;
                };
                tx.oncomplete = () => {
                    database.close();
                    resolve({ imageCount: seededImageCount, remoteCount: seededRemoteCount });
                };
                tx.onerror = () => {
                    const error = tx.error || new Error('seed transaction failed');
                    database.close();
                    reject(error);
                };
                tx.onabort = () => {
                    const error = tx.error || new Error('seed transaction aborted');
                    database.close();
                    reject(error);
                };
            };
        })
    ), {
        databaseName: DB_NAME,
        imagesToSeed: imageCount,
        remoteToSeed: remoteCount,
        queueRecord: queue,
        userRecords: users
    });
}

async function installLocalStorageSecurityError(page) {
    await page.addInitScript(() => {
        for (const method of ['getItem', 'setItem', 'removeItem']) {
            const nativeMethod = Storage.prototype[method];
            Object.defineProperty(Storage.prototype, method, {
                configurable: true,
                writable: true,
                value(...args) {
                    if (this === window.localStorage) {
                        throw new DOMException('Storage access denied by browser policy', 'SecurityError');
                    }
                    return Reflect.apply(nativeMethod, this, args);
                }
            });
        }
    });
}

async function installQueueQuotaFailure(page, { persistent = false } = {}) {
    await page.addInitScript(({ failPersistently }) => {
        const nativePut = IDBObjectStore.prototype.put;
        const probe = { injectedFailures: 0, currentQueuePutAttempts: 0 };
        Object.defineProperty(IDBObjectStore.prototype, 'put', {
            configurable: true,
            writable: true,
            value(value, ...rest) {
                if (this.name === 'playlists' && value && value.id === 'current_queue') {
                    probe.currentQueuePutAttempts += 1;
                    if (failPersistently || probe.injectedFailures === 0) {
                        probe.injectedFailures += 1;
                        throw new DOMException('Injected queue quota failure', 'QuotaExceededError');
                    }
                }
                return Reflect.apply(nativePut, this, [value, ...rest]);
            }
        });
        window.__cplayerStorageQuotaProbe = {
            snapshot: () => ({ ...probe }),
            restoreNativePut() {
                Object.defineProperty(IDBObjectStore.prototype, 'put', {
                    configurable: true,
                    writable: true,
                    value: nativePut
                });
            }
        };
    }, { failPersistently: persistent });
}

async function installRemotePlaylistCacheQuotaFailure(page) {
    await page.addInitScript(() => {
        const nativePut = IDBObjectStore.prototype.put;
        const probe = { attempts: 0, ids: [] };
        Object.defineProperty(IDBObjectStore.prototype, 'put', {
            configurable: true,
            writable: true,
            value(value, ...rest) {
                const id = value && value.id != null ? String(value.id) : '';
                const isRemotePlaylist = this.name === 'playlists' && id &&
                    id !== 'current_queue' && !id.startsWith('user_pl_');
                if (isRemotePlaylist) {
                    probe.attempts += 1;
                    probe.ids.push(id);
                    throw new DOMException('Injected optional cache quota failure', 'QuotaExceededError');
                }
                return Reflect.apply(nativePut, this, [value, ...rest]);
            }
        });
        window.__cplayerRemoteCacheQuotaProbe = {
            snapshot: () => ({ attempts: probe.attempts, ids: probe.ids.slice() })
        };
    });
}

test('localStorage SecurityError keeps the app ready and warns that changes may not persist', async ({ page }) => {
    await installLocalStorageSecurityError(page);

    await page.goto('/index.html');
    await waitForAppReady(page);

    await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'degraded');
    await expect(page.locator('#copyToast span')).toContainText('本次修改可能无法保留');
    await openSettings(page);
    await expect(page.locator('#settingsModal')).toBeVisible();
});

test('a real version-3 connection blocks version 5 without hanging application startup', async ({ page, context }) => {
    const holder = await context.newPage();
    await openStorageHarness(holder);
    const legacy = await openTestDatabase(holder, 3, { hold: true });
    expect(legacy.version).toBe(3);

    try {
        await page.goto('/index.html');
        await waitForAppReady(page);

        await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'blocked');
        await expect(page.locator('#copyToast span')).toContainText('关闭其他页面后刷新');
    } finally {
        await closeHeldDatabases(holder);
    }
});

test('a later version-6 upgrade makes the old application page stale', async ({ page, context }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'ready');

    const upgrader = await context.newPage();
    await openStorageHarness(upgrader);
    const upgraded = await openTestDatabase(upgrader, 6, { hold: true });
    expect(upgraded.version).toBe(6);

    try {
        await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'stale');
        await expect(page.locator('#copyToast span')).toContainText('请刷新当前页面');

        await page.evaluate(async (song) => {
            window.addSongToQueueOnly(song, { toast: false });
            window.dispatchEvent(new Event('pagehide'));
            await Promise.resolve();
        }, STALE_SONG);
        expect(await page.evaluate(() => window.playlist.map((song) => song.id))).toEqual([STALE_SONG.id]);
        expect((await readStorageSnapshot(upgrader)).queue).toBeNull();

        await openLibrary(page);
        await page.getByRole('button', { name: '导出歌单备份' }).click();
        await expect(page.locator('#copyToast span')).toHaveText('歌单导出失败');
        await expect(page.locator('#copyToast span')).not.toContainText('已导出 0 个歌单');
        await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'stale');
    } finally {
        await closeHeldDatabases(upgrader);
    }
});

test('queue revision rejects a stale page before it can replace the winning record', async ({ page, context }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    const stalePage = await context.newPage();
    await stalePage.goto('/index.html');
    await waitForAppReady(stalePage);
    expect(await page.evaluate(() => window.playlist.length)).toBe(0);
    expect(await stalePage.evaluate(() => window.playlist.length)).toBe(0);

    await page.evaluate((song) => window.addSongToQueueOnly(song, { toast: false }), WINNER_SONG);
    await expect.poll(async () => (await readStorageSnapshot(page)).queue?.revision || 0)
        .toBe(1);
    const winner = (await readStorageSnapshot(page)).queue;
    expect(winner.songs.map((song) => song.id)).toEqual([WINNER_SONG.id]);
    expect(winner.writerId).toEqual(expect.any(String));

    await stalePage.evaluate((song) => window.addSongToQueueOnly(song, { toast: false }), STALE_SONG);
    await expect(stalePage.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'conflict');
    await expect(stalePage.locator('#copyToast span')).toContainText('刷新后再操作');
    expect(await stalePage.evaluate(() => window.playlist.map((song) => song.id))).toEqual([STALE_SONG.id]);

    const afterConflict = (await readStorageSnapshot(page)).queue;
    expect(afterConflict).toEqual(winner);
});

test('non-empty playlist.js adopts the stored queue revision across reload', async ({ page }) => {
    const playlistRequests = [];
    await page.route(/\/playlist\.js(?:\?|$)/, async (route) => {
        playlistRequests.push(route.request().url());
        await route.fulfill({
            status: 200,
            contentType: 'text/javascript; charset=utf-8',
            body: `window.LOCAL_PLAYLIST = ${JSON.stringify({
                title: '受控内置歌单',
                data: { tracks: LOCAL_PLAYLIST_TRACKS }
            })};`
        });
    });

    await page.goto('/index.html');
    await waitForAppReady(page);
    await expect.poll(async () => (await readStorageSnapshot(page)).queue?.revision || 0)
        .toBe(1);
    const firstRecord = (await readStorageSnapshot(page)).queue;
    expect(firstRecord.songs.map((song) => song.id))
        .toEqual(LOCAL_PLAYLIST_TRACKS.map((song) => song.id));
    await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'ready');

    await page.reload();
    await waitForAppReady(page);
    await expect.poll(async () => {
        const queue = (await readStorageSnapshot(page)).queue;
        return {
            revision: queue?.revision || 0,
            storageState: await page.locator('html').getAttribute('data-cplayer-storage-state')
        };
    }).toEqual({ revision: 2, storageState: 'ready' });

    const secondRecord = (await readStorageSnapshot(page)).queue;
    expect(secondRecord.songs.map((song) => song.id))
        .toEqual(LOCAL_PLAYLIST_TRACKS.map((song) => song.id));
    expect(secondRecord.writerId).not.toBe(firstRecord.writerId);
    await expect(page.locator('#copyToast span')).not.toContainText('刷新后再操作');
    expect(playlistRequests).toHaveLength(2);
});

test('reload prunes only overflow caches and preserves queue and user playlists', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    const schema = await readStorageSnapshot(page);
    expect(schema.version).toBe(DB_VERSION);
    expect(schema.imageIndexes).toContain('timestamp');

    const seeded = await seedTransientCaches(page, {
        imageCount: 168,
        remoteCount: 16,
        queue: PROTECTED_QUEUE,
        users: [PROTECTED_USER_PLAYLIST]
    });
    expect(seeded.imageCount).toBeGreaterThan(160);
    expect(seeded.remoteCount).toBeGreaterThan(12);

    await page.reload();
    await waitForAppReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'ready');
    await expect.poll(async () => {
        const snapshot = await readStorageSnapshot(page);
        return { images: snapshot.imageCount, remote: snapshot.remoteCount };
    }).toEqual({ images: 160, remote: 12 });

    const afterPrune = await readStorageSnapshot(page);
    expect(afterPrune.queue).toEqual(PROTECTED_QUEUE);
    expect(afterPrune.users).toEqual([PROTECTED_USER_PLAYLIST]);
    expect(await page.evaluate(() => window.playlist.map((song) => song.id)))
        .toEqual(PROTECTED_QUEUE.songs.map((song) => song.id));
});

test('one-shot queue quota failure clears transient caches and retries the critical write', async ({ page }) => {
    await openStorageHarness(page);
    const database = await openTestDatabase(page, DB_VERSION);
    expect(database.version).toBe(DB_VERSION);
    const seeded = await seedTransientCaches(page, {
        imageCount: 4,
        remoteCount: 3,
        users: [PROTECTED_USER_PLAYLIST]
    });
    expect(seeded).toEqual({ imageCount: 4, remoteCount: 3 });
    await installQueueQuotaFailure(page);

    await page.goto('/index.html');
    await waitForAppReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'ready');
    await page.evaluate((song) => window.addSongToQueueOnly(song, { toast: false }), WINNER_SONG);

    await expect.poll(async () => (await readStorageSnapshot(page)).queue?.songs?.[0]?.id || null)
        .toBe(WINNER_SONG.id);
    await expect.poll(() => page.evaluate(() => window.__cplayerStorageQuotaProbe.snapshot()))
        .toEqual({ injectedFailures: 1, currentQueuePutAttempts: 2 });

    const afterRetry = await readStorageSnapshot(page);
    expect(afterRetry.imageCount).toBe(0);
    expect(afterRetry.remoteCount).toBe(0);
    expect(afterRetry.users).toEqual([PROTECTED_USER_PLAYLIST]);
    expect(afterRetry.queue.revision).toBe(1);
});

test('persistent queue quota failure reports failure and a later write can recover', async ({ page }) => {
    await installQueueQuotaFailure(page, { persistent: true });

    await page.goto('/index.html');
    await waitForAppReady(page);
    await page.evaluate((song) => window.addSongToQueueOnly(song, { toast: false }), WINNER_SONG);

    await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'degraded');
    await expect(page.locator('#copyToast span')).toContainText('存储空间不足');
    expect((await readStorageSnapshot(page)).queue).toBeNull();
    expect(await page.evaluate(() => window.__cplayerStorageQuotaProbe.snapshot())).toEqual({
        injectedFailures: 2,
        currentQueuePutAttempts: 2
    });

    await page.evaluate(() => window.__cplayerStorageQuotaProbe.restoreNativePut());
    await page.evaluate((song) => window.addSongToQueueOnly(song, { toast: false }), RECOVERY_SONG);
    await expect.poll(async () => {
        const queue = (await readStorageSnapshot(page)).queue;
        return queue ? queue.songs.map((song) => song.id) : [];
    }).toEqual([WINNER_SONG.id, RECOVERY_SONG.id]);
    expect((await readStorageSnapshot(page)).queue.revision).toBe(1);
});

test('remote playlist remains rendered when its optional cache write hits quota', async ({ page }, testInfo) => {
    const loadFailures = [];
    page.on('console', (message) => {
        if (message.type() === 'error' && message.text().includes('播放列表加载失败')) {
            loadFailures.push(message.text());
        }
    });
    const playlistRequests = [];
    await page.route(/\/163_playlist\?/, async (route) => {
        playlistRequests.push(route.request().url());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { tracks: REMOTE_PLAYLIST_SONGS } })
        });
    });
    await installRemotePlaylistCacheQuotaFailure(page);

    await page.goto('/index.html');
    await openSettings(page);
    await page.locator('#playlistIdInput').fill(REMOTE_PLAYLIST_ID);
    await page.locator('#loadPlaylistBtn').click();

    await expect(page.locator('#settingsModal')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.playlist.map((song) => song.id)))
        .toEqual(REMOTE_PLAYLIST_SONGS.map((song) => song.id));
    await expect(page.locator('html')).toHaveAttribute('data-cplayer-storage-state', 'degraded');
    await expect(page.locator('#copyToast span')).toContainText('缓存空间不足');
    await expect(page.locator('#copyToast span')).not.toContainText('播放列表加载失败');

    if (testInfo.project.name === 'mobile-chromium') {
        await page.getByRole('button', { name: '打开播放列表' }).click();
        await expect(page.locator('#mobilePlaylistSheet')).toHaveClass(/translate-y-0/);
        await expect(page.locator('#mobilePlaylistContainer')).toContainText(REMOTE_PLAYLIST_SONGS[0].name);
    } else {
        await page.getByRole('button', { name: '打开播放列表和搜索' }).click();
        await expect(page.locator('#floatingPlaylistPanel')).not.toHaveClass(/translate-x-full/);
        await expect(page.locator('#playlistContent')).toContainText(REMOTE_PLAYLIST_SONGS[0].name);
    }

    expect(playlistRequests).toHaveLength(1);
    expect(new URL(playlistRequests[0]).searchParams.get('id')).toBe(REMOTE_PLAYLIST_ID);
    expect(await page.evaluate(() => window.__cplayerRemoteCacheQuotaProbe.snapshot()))
        .toEqual({ attempts: 1, ids: [REMOTE_PLAYLIST_ID] });
    expect((await readStorageSnapshot(page)).remoteCount).toBe(0);
    expect(loadFailures).toEqual([]);
});
