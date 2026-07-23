import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

const swSource = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const cacheNameMatch = swSource.match(/const CACHE_NAME = '([^']+)'/);
if (!cacheNameMatch) throw new Error('Unable to read the current Service Worker cache name');

const CURRENT_CACHE_NAME = cacheNameMatch[1];
const UNRELATED_CACHE_NAME = 'unrelated-service-worker-isolation';
const DYNAMIC_API_PATH_SEGMENTS = [
    '163_search',
    '163_music',
    '163_lyric',
    '163_playlist'
];

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

async function fetchText(page, requestUrl, headers = {}) {
    return page.evaluate(async ({ url, requestHeaders }) => {
        const response = await fetch(url, { cache: 'no-store', headers: requestHeaders });
        return {
            body: await response.text(),
            contentType: response.headers.get('content-type'),
            status: response.status
        };
    }, { url: requestUrl, requestHeaders: headers });
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

test('authorized same-origin requests bypass CacheStorage reads and writes', async ({ page }) => {
    await installCurrentWorker(page);

    const requestUrl = `/manifest.json?auth-probe=${encodeURIComponent(randomUUID())}`;
    const cachedMarker = `authorized-cached-response-${randomUUID()}`;
    const authorization = `Bearer ${randomUUID()}`;
    await page.evaluate(async ({ cacheName, url, marker }) => {
        await (await caches.open(cacheName)).put(url, new Response(marker, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            status: 200
        }));
    }, { cacheName: CURRENT_CACHE_NAME, url: requestUrl, marker: cachedMarker });

    const firstResponse = await fetchText(page, requestUrl, { Authorization: authorization });
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

    const secondResponse = await fetchText(page, requestUrl, { Authorization: authorization });
    expect(secondResponse.status).toBe(200);
    expect(JSON.parse(secondResponse.body).name).toBe('CPlayer 5');
    expect(await page.evaluate(async (url) => Boolean(await caches.match(url)), requestUrl)).toBe(false);
});

test('known Supabase auth paths bypass CacheStorage without an authorization header', async ({ page }) => {
    await installCurrentWorker(page);

    const requestUrl = `/__test__/auth/v1/session?auth-path-probe=${encodeURIComponent(randomUUID())}`;
    const cachedMarker = `auth-path-cached-response-${randomUUID()}`;
    await page.evaluate(async ({ cacheName, url, marker }) => {
        await (await caches.open(cacheName)).put(url, new Response(marker, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            status: 200
        }));
    }, { cacheName: CURRENT_CACHE_NAME, url: requestUrl, marker: cachedMarker });

    const firstResponse = await fetchText(page, requestUrl);
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.body).not.toBe(cachedMarker);
    expect(JSON.parse(firstResponse.body).endpoint).toBe('auth-v1');

    await page.evaluate(async ({ cacheName, url }) => {
        await (await caches.open(cacheName)).delete(url);
    }, { cacheName: CURRENT_CACHE_NAME, url: requestUrl });
    const secondResponse = await fetchText(page, requestUrl);
    expect(secondResponse.status).toBe(200);
    expect(JSON.parse(secondResponse.body).endpoint).toBe('auth-v1');
    expect(await page.evaluate(async (url) => Boolean(await caches.match(url)), requestUrl)).toBe(false);
});

test('key-free same-origin dynamic API segments bypass CacheStorage reads and writes', async ({ page }) => {
    await installCurrentWorker(page);

    for (const segment of DYNAMIC_API_PATH_SEGMENTS) {
        const requestUrl = `/__test__/${segment}?probe=${encodeURIComponent(randomUUID())}`;
        const currentMarker = `current-cache-${randomUUID()}`;
        const unrelatedMarker = `unrelated-cache-${randomUUID()}`;
        await page.evaluate(async ({ currentName, unrelatedName, url, currentBody, unrelatedBody }) => {
            await (await caches.open(currentName)).put(url, new Response(currentBody));
            await (await caches.open(unrelatedName)).put(url, new Response(unrelatedBody));
        }, {
            currentName: CURRENT_CACHE_NAME,
            unrelatedName: UNRELATED_CACHE_NAME,
            url: requestUrl,
            currentBody: currentMarker,
            unrelatedBody: unrelatedMarker
        });

        const firstResponse = await fetchText(page, requestUrl);
        expect(firstResponse.status).toBe(200);
        expect(firstResponse.contentType).toBe('application/json; charset=utf-8');
        expect(firstResponse.body).not.toBe(currentMarker);
        expect(firstResponse.body).not.toBe(unrelatedMarker);
        const firstPayload = JSON.parse(firstResponse.body);
        expect(firstPayload).toMatchObject({ code: 200, endpoint: segment });
        expect(firstPayload.sequence).toBeGreaterThan(0);

        const seededBodies = await page.evaluate(async ({ currentName, unrelatedName, url }) => {
            const current = await (await caches.open(currentName)).match(url);
            const unrelated = await (await caches.open(unrelatedName)).match(url);
            return {
                current: current ? await current.text() : null,
                unrelated: unrelated ? await unrelated.text() : null
            };
        }, {
            currentName: CURRENT_CACHE_NAME,
            unrelatedName: UNRELATED_CACHE_NAME,
            url: requestUrl
        });
        expect(seededBodies.current).toBe(currentMarker);
        expect(seededBodies.unrelated).toBe(unrelatedMarker);

        await page.evaluate(async ({ currentName, unrelatedName, url }) => {
            await (await caches.open(currentName)).delete(url);
            await (await caches.open(unrelatedName)).delete(url);
        }, {
            currentName: CURRENT_CACHE_NAME,
            unrelatedName: UNRELATED_CACHE_NAME,
            url: requestUrl
        });

        const secondResponse = await fetchText(page, requestUrl);
        expect(secondResponse.status).toBe(200);
        expect(secondResponse.contentType).toBe('application/json; charset=utf-8');
        const secondPayload = JSON.parse(secondResponse.body);
        expect(secondPayload).toMatchObject({ code: 200, endpoint: segment });
        expect(secondPayload.sequence).toBeGreaterThan(firstPayload.sequence);
        expect(secondResponse.body).not.toBe(firstResponse.body);

        const cachePresence = await page.evaluate(async ({ currentName, unrelatedName, url }) => ({
            current: Boolean(await (await caches.open(currentName)).match(url)),
            unrelated: Boolean(await (await caches.open(unrelatedName)).match(url))
        }), {
            currentName: CURRENT_CACHE_NAME,
            unrelatedName: UNRELATED_CACHE_NAME,
            url: requestUrl
        });
        expect(cachePresence).toEqual({ current: false, unrelated: false });
    }
});

test('unrelated cache cannot supply an application resource with the same URL', async ({ page }) => {
    await installCurrentWorker(page);

    const requestUrl = `/manifest.json?isolation=${encodeURIComponent(randomUUID())}`;
    const unrelatedMarker = `unrelated-cache-${randomUUID()}`;
    await page.evaluate(async ({ cacheName, url, marker }) => {
        await (await caches.open(cacheName)).put(url, new Response(marker, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }));
    }, { cacheName: UNRELATED_CACHE_NAME, url: requestUrl, marker: unrelatedMarker });

    const response = await fetchText(page, requestUrl);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json; charset=utf-8');
    expect(response.body).not.toBe(unrelatedMarker);
    expect(JSON.parse(response.body).name).toBe('CPlayer 5');

    const cacheBodies = await page.evaluate(async ({ currentName, unrelatedName, url }) => {
        const current = await (await caches.open(currentName)).match(url);
        const unrelated = await (await caches.open(unrelatedName)).match(url);
        return {
            current: current ? await current.text() : null,
            unrelated: unrelated ? await unrelated.text() : null
        };
    }, {
        currentName: CURRENT_CACHE_NAME,
        unrelatedName: UNRELATED_CACHE_NAME,
        url: requestUrl
    });
    expect(cacheBodies.current).toContain('"name": "CPlayer 5"');
    expect(cacheBodies.unrelated).toBe(unrelatedMarker);
});
