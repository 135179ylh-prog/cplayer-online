import { test, expect } from '@playwright/test';
import { openSettings, waitForAppReady } from './helpers.mjs';

async function readStorageFingerprint(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const local = Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]);
        const request = indexedDB.open('CPlayer5DB', 6);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const names = ['playlists', 'cloud_outbox', 'playlist_versions']
                .filter((name) => database.objectStoreNames.contains(name));
            const transaction = database.transaction(names, 'readonly');
            const reads = names.map((name) => new Promise((resolveStore, rejectStore) => {
                const get = transaction.objectStore(name).getAll();
                get.onsuccess = () => resolveStore([name, get.result || []]);
                get.onerror = () => rejectStore(get.error);
            }));
            Promise.all(reads).then((stores) => {
                database.close();
                resolve({ local, stores });
            }, (error) => {
                database.close();
                reject(error);
            });
        };
    }));
}

test('本机同步健康检查只读、可导出脱敏报告', async ({ page }) => {
    await page.addInitScript(() => {
        window.CPLAYER_CLOUD_CONFIG = { url: '', publishableKey: '' };
    });
    await page.goto('/index.html');
    await waitForAppReady(page);

    if (await page.evaluate(() => 'serviceWorker' in navigator)) {
        await page.evaluate(async () => { await navigator.serviceWorker.ready; });
        await page.reload();
        await waitForAppReady(page);
    }

    await openSettings(page);
    const before = await readStorageFingerprint(page);
    await page.locator('#cloudHealthCheckBtn').click();
    await expect(page.locator('#cloudHealthCheckStatus')).toContainText('检查完成');
    await expect(page.locator('#cloudHealthCheckList > div')).toHaveCount(4);

    const report = await page.evaluate(() => window.getCloudHealthReport());
    expect(report).toMatchObject({ format: 'cplayer-sync-health-report', version: 1 });
    expect(report.items).toHaveLength(4);
    const reportText = JSON.stringify(report);
    for (const forbidden of ['apikey', 'publishableKey', 'apiBase', 'cloudOwnerId', 'userId', 'email', 'songs', 'current_queue', 'recent_history', 'playback']) {
        expect(reportText.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    const after = await readStorageFingerprint(page);
    expect(after).toEqual(before);
    await expect(page.locator('#cloudHealthCheckExportBtn')).toBeVisible();
    await expect(page.locator('#cloudHealthCheckBtn')).toBeEnabled();
});

test('健康检查使用最新 outbox 数量并把待办标为需留意', async ({ page }) => {
    await page.addInitScript(() => {
        window.CPLAYER_CLOUD_CONFIG = { url: '', publishableKey: '' };
    });
    await page.goto('/index.html');
    await waitForAppReady(page);
    await openSettings(page);

    await page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('CPlayer5DB', 6);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('cloud_outbox', 'readwrite');
            transaction.objectStore('cloud_outbox').put({
                id: 'health-freshness-test',
                ownerId: 'health-freshness-owner',
                playlistId: 'user_pl_health_freshness',
                operation: 'upsert',
                mutationId: 'health-freshness-mutation',
                updatedAt: Date.now()
            });
            transaction.oncomplete = () => {
                database.close();
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
        };
    }));

    await page.locator('#cloudHealthCheckBtn').click();
    await expect(page.locator('#cloudHealthCheckStatus')).toContainText('1 项需留意');
    const report = await page.evaluate(() => window.getCloudHealthReport());
    const indexedDb = report.items.find((item) => item.id === 'indexeddb');
    const cloud = report.items.find((item) => item.id === 'cloud');
    expect(indexedDb.detail).toContain('待同步 1 项');
    expect(cloud.status).toBe('warn');
    expect(cloud.detail).toContain('1 项');
    expect(cloud.recommendation).toMatch(/登录|联网|同步/);
});
