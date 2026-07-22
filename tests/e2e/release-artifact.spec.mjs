import { test, expect } from '@playwright/test';
import { waitForAppReady } from './helpers.mjs';

test.skip(!process.env.PW_WEB_ROOT, 'release artifact checks require the explicit Pages web root');

const PUBLIC_PATHS = [
    '/index.html',
    '/manifest.json',
    '/playlist.js',
    '/playlist-downloader.html',
    '/sw.js',
    '/css/tailwind.css',
    '/js/app.js',
    '/js/core-utils.js',
    '/img/icon.png'
];

const PRIVATE_PATHS = [
    '/.github/workflows/pages.yml',
    '/.trellis/tasks/07-22-final-release-preflight/prd.md',
    '/AGENTS.md',
    '/package.json',
    '/scripts/run-quality-gate.mjs',
    '/tests/e2e/server.mjs'
];

test('verified Pages artifact exposes only the deployable runtime and reloads offline', async ({ context, page, request }) => {
    for (const path of PUBLIC_PATHS) {
        const response = await request.get(path);
        expect(response.status(), `${path} must be present in the Pages artifact`).toBe(200);
    }
    for (const path of PRIVATE_PATHS) {
        const response = await request.get(path);
        expect(response.status(), `${path} must stay outside the Pages artifact`).toBe(404);
    }

    await page.goto('/index.html');
    await waitForAppReady(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || ''))
        .toMatch(/\/sw\.js$/);

    await context.setOffline(true);
    try {
        await page.reload();
        await waitForAppReady(page);
        await expect(page.locator('#buildBadge')).toHaveText(/^v\d+$/);
    } finally {
        await context.setOffline(false);
    }
});
