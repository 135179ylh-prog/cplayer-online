import { test, expect } from '@playwright/test';
import { collectUnexpectedErrors, waitForAppReady } from './helpers.mjs';

test('application shell starts without unexpected runtime errors', async ({ page }, testInfo) => {
    const errors = collectUnexpectedErrors(page);

    await page.goto('/index.html');
    await expect(page.locator('#buildBadge')).toHaveText(/^v\d+$/);
    await expect(page.locator('#appUpdateBanner')).toBeHidden();

    if (testInfo.project.name === 'mobile-chromium') {
        await expect(page.locator('#mobileLayout')).toBeVisible();
        await expect(page.locator('#desktopLayout')).toBeHidden();
        await expect(page.getByRole('button', { name: '播放/暂停' })).toBeVisible();
    } else {
        await expect(page.locator('#desktopLayout')).toBeVisible();
        await expect(page.locator('#mobileLayout')).toBeHidden();
        await expect(page.getByRole('button', { name: '打开播放列表和搜索' })).toBeVisible();
    }

    await page.waitForTimeout(750);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('external app module loads once as JavaScript', async ({ page }) => {
    const moduleResponses = [];
    page.on('response', (response) => {
        if (new URL(response.url()).pathname !== '/js/app.js') return;
        moduleResponses.push({
            status: response.status(),
            contentType: response.headers()['content-type'] || ''
        });
    });

    await page.goto('/index.html');
    await waitForAppReady(page);

    expect(moduleResponses).toEqual([{
        status: 200,
        contentType: 'text/javascript; charset=utf-8'
    }]);
    const resources = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).pathname === '/js/app.js')
        .map((entry) => ({ initiatorType: entry.initiatorType, transferSize: entry.transferSize })));
    expect(resources).toHaveLength(1);
    expect(resources[0].initiatorType).toBe('script');
    expect(resources[0].transferSize).toBeGreaterThan(0);
});

test('cached application shell reloads while offline', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'One Chromium context is sufficient for the Service Worker contract.');

    await page.goto('/index.html');
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.reload();
    await expect(page.locator('#buildBadge')).toHaveText(/^v\d+$/);

    await context.setOffline(true);
    try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#desktopLayout')).toBeVisible();
        await expect(page.locator('#buildBadge')).toHaveText(/^v\d+$/);
    } finally {
        await context.setOffline(false);
    }
});
