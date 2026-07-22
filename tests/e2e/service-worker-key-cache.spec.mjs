import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

const swSource = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const cacheNameMatch = swSource.match(/const CACHE_NAME = '([^']+)'/);
if (!cacheNameMatch) throw new Error('Unable to read the current Service Worker cache name');

const CURRENT_CACHE_NAME = cacheNameMatch[1];

async function installCurrentWorker(page) {
    await page.goto('/playlist-downloader.html');
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            updateViaCache: 'none'
        });
        await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js'));
}

async function fetchText(page, requestUrl) {
    return page.evaluate(async (url) => {
        const response = await fetch(url, { cache: 'no-store' });
        return {
            body: await response.text(),
            contentType: response.headers.get('content-type'),
            status: response.status
        };
    }, requestUrl);
}

test('same-origin apikey requests bypass CacheStorage reads and writes', async ({ page }) => {
    await installCurrentWorker(page);

    const requestUrl = `/manifest.json?apikey=${encodeURIComponent(randomUUID())}`;
    const cachedMarker = `cached-response-${randomUUID()}`;
    await page.evaluate(async ({ cacheName, url, marker }) => {
        const cache = await caches.open(cacheName);
        await cache.put(url, new Response(marker, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            status: 200
        }));
    }, { cacheName: CURRENT_CACHE_NAME, url: requestUrl, marker: cachedMarker });

    const firstResponse = await fetchText(page, requestUrl);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.contentType).toBe('application/json; charset=utf-8');
    expect(firstResponse.body).not.toBe(cachedMarker);
    expect(JSON.parse(firstResponse.body).name).toBe('CPlayer 5');

    const cachedBody = await page.evaluate(async ({ cacheName, url }) => {
        const response = await (await caches.open(cacheName)).match(url);
        return response ? response.text() : null;
    }, { cacheName: CURRENT_CACHE_NAME, url: requestUrl });
    expect(cachedBody).toBe(cachedMarker);

    await page.evaluate(async ({ cacheName, url }) => {
        await (await caches.open(cacheName)).delete(url);
    }, { cacheName: CURRENT_CACHE_NAME, url: requestUrl });
    expect(await page.evaluate(async (url) => Boolean(await caches.match(url)), requestUrl)).toBe(false);

    const secondResponse = await fetchText(page, requestUrl);
    expect(secondResponse.status).toBe(200);
    expect(JSON.parse(secondResponse.body).name).toBe('CPlayer 5');
    expect(await page.evaluate(async (url) => Boolean(await caches.match(url)), requestUrl)).toBe(false);
});
