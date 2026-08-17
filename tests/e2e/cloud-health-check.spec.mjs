import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { collectUnexpectedErrors, openSettings, waitForAppReady } from './helpers.mjs';

// The health check swallows any error into a generic "检查失败" message, so a
// missing import after a module extraction shows up only as that text with the
// real ReferenceError hidden in console.warn. Failing the spec on an unexpected
// runtime error surfaces the cause instead of the symptom.
const ALLOWED_HEALTH_ERRORS = [];

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
    const errors = collectUnexpectedErrors(page, ALLOWED_HEALTH_ERRORS);
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

    expect(errors, errors.join('\n')).toEqual([]);
});

test('导出的健康报告文件与内存报告一致且不含敏感字段', async ({ page }) => {
    await page.addInitScript(() => {
        window.CPLAYER_CLOUD_CONFIG = { url: '', publishableKey: '' };
    });
    await page.goto('/index.html');
    await waitForAppReady(page);
    await openSettings(page);

    // A local API key and a queue must exist before the export so the download
    // is proven redacted against real local data, not against an empty profile.
    await page.evaluate(() => {
        localStorage.setItem('cp_api_key', 'health-export-secret-key');
        localStorage.setItem('cp_api_base', 'https://health-export.example.invalid/api');
        localStorage.setItem('current_queue', JSON.stringify([{ id: 424242, name: '导出队列歌曲' }]));
        localStorage.setItem('cp_recent_history', JSON.stringify([{ id: 424243, name: '导出历史歌曲' }]));
    });
    await page.locator('#cloudHealthCheckBtn').click();
    await expect(page.locator('#cloudHealthCheckStatus')).toContainText('检查完成');

    const memoryReport = await page.evaluate(() => window.getCloudHealthReport());
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#cloudHealthCheckExportBtn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^cplayer-sync-health-\d{4}-\d{2}-\d{2}\.json$/);
    const written = JSON.parse(await readFile(await download.path(), 'utf8'));

    expect(written).toEqual(memoryReport);
    expect(written.format).toBe('cplayer-sync-health-report');
    expect(written.stale).toBe(false);
    expect(Object.keys(written).sort()).toEqual(['format', 'generatedAt', 'items', 'stale', 'summary', 'version']);
    for (const item of written.items) {
        expect(Object.keys(item).sort().filter((key) => key !== 'lastError'))
            .toEqual(['detail', 'id', 'recommendation', 'status', 'title']);
    }
    const serialized = JSON.stringify(written);
    for (const forbidden of [
        'health-export-secret-key', 'health-export.example.invalid', 'apikey', 'apiBase',
        'publishableKey', 'cloudOwnerId', 'ownerId', 'userId', 'email', 'revision',
        '导出队列歌曲', '导出历史歌曲', 'current_queue', 'cp_recent_history', 'playback'
    ]) {
        expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
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
