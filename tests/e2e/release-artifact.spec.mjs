import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { waitForAppReady } from './helpers.mjs';

test.skip(!process.env.PW_WEB_ROOT, 'release artifact checks require the explicit Pages web root');

const ARTIFACT_BYTE_BUDGET = 20_000_000;

function measureArtifactBytes(directory) {
    return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
        const path = resolve(directory, entry.name);
        return total + (entry.isDirectory() ? measureArtifactBytes(path) : statSync(path).size);
    }, 0);
}

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

const FONT_FACES = [
    {
        weight: 400,
        path: '/fonts/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.woff2'
    },
    {
        weight: 500,
        path: '/fonts/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG-3FnYw.woff2'
    },
    {
        weight: 700,
        path: '/fonts/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYw.woff2'
    },
    {
        weight: 900,
        path: '/fonts/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG3bCnYw.woff2'
    }
];

const LEGACY_FONT_PATHS = FONT_FACES.map(({ path }) => path.replace(/\.woff2$/, '.ttf'));

async function loadNotoFaces(page) {
    return page.evaluate(async (faces) => {
        const sample = '中文歌曲歌词测试，標點 ABC 123';
        const loaded = [];
        for (const face of faces) {
            const matches = await document.fonts.load(
                `${face.weight} 16px "Noto Sans SC"`,
                sample
            );
            loaded.push({
                weight: face.weight,
                matches: matches.map((font) => ({
                    family: font.family,
                    status: font.status,
                    weight: font.weight
                })),
                check: document.fonts.check(`${face.weight} 16px "Noto Sans SC"`, sample)
            });
        }
        return {
            loaded,
            resources: performance.getEntriesByType('resource')
                .map((entry) => entry.name)
                .filter((name) => /\/fonts\/[^/?]+\.(?:woff2|ttf)(?:\?|$)/i.test(name))
        };
    }, FONT_FACES);
}

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

test('Pages artifact loads every Noto weight online and offline', async ({ context, page, request }) => {
    expect(measureArtifactBytes(process.env.PW_WEB_ROOT)).toBeLessThanOrEqual(ARTIFACT_BYTE_BUDGET);

    const cssResponse = await request.get('/css/noto-sans-sc.css');
    expect(cssResponse.status()).toBe(200);
    const cssText = await cssResponse.text();
    expect(cssText).toContain("format('woff2')");
    expect(cssText).not.toMatch(/\.ttf|truetype/i);
    const cssBlocks = cssText.split('@font-face').slice(1);
    for (const face of FONT_FACES) {
        const filename = face.path.split('/').at(-1);
        const block = cssBlocks.find((candidate) => candidate.includes(filename));
        expect(block, `${filename} must have its own @font-face block`).toBeTruthy();
        expect(block).toContain(`font-weight: ${face.weight};`);
        expect(block).toContain("format('woff2')");
    }

    for (const face of FONT_FACES) {
        const response = await request.get(face.path);
        expect(response.status(), `${face.path} must be present`).toBe(200);
        expect(response.headers()['content-type']).toMatch(/^font\/woff2(?:;|$)/);
    }
    for (const legacyPath of LEGACY_FONT_PATHS) {
        expect((await request.get(legacyPath)).status(), `${legacyPath} must be removed`).toBe(404);
    }

    await page.goto('/index.html');
    await waitForAppReady(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || ''))
        .toMatch(/\/sw\.js$/);

    const runtimeResponses = await page.evaluate(async (paths) => Promise.all(paths.map(async (path) => {
        const response = await fetch(path, { cache: 'reload' });
        return {
            path,
            status: response.status,
            contentType: response.headers.get('content-type') || ''
        };
    })), FONT_FACES.map(({ path }) => path));
    for (const response of runtimeResponses) {
        expect(response.status, `${response.path} must load through the active Worker`).toBe(200);
        expect(response.contentType).toMatch(/^font\/woff2(?:;|$)/);
    }

    const online = await loadNotoFaces(page);
    for (const result of online.loaded) {
        expect(result.check, `Noto weight ${result.weight} should pass document.fonts.check`).toBe(true);
        expect(result.matches.some((font) => font.status === 'loaded'),
            `Noto weight ${result.weight} should have a loaded FontFace`).toBe(true);
    }
    expect(online.resources.some((name) => /\.ttf(?:\?|$)/i.test(name))).toBe(false);
    for (const face of FONT_FACES) {
        expect(online.resources.some((name) => name.endsWith(face.path)),
            `${face.path} should be requested by the browser`).toBe(true);
    }

    const cachedFonts = await page.evaluate(async () => {
        const names = await caches.keys();
        const currentName = names.find((name) => name.startsWith('cplayer5-v61-'));
        if (!currentName) return { currentName: null, urls: [] };
        const keys = await (await caches.open(currentName)).keys();
        return {
            currentName,
            urls: keys.map((request) => new URL(request.url).pathname)
        };
    });
    expect(cachedFonts.currentName).toBe('cplayer5-v61-font-footprint-optimization');
    for (const face of FONT_FACES) expect(cachedFonts.urls).toContain(face.path);

    await context.setOffline(true);
    try {
        await page.reload();
        await waitForAppReady(page);
        const offline = await loadNotoFaces(page);
        for (const result of offline.loaded) {
            expect(result.check, `offline Noto weight ${result.weight} should remain available`).toBe(true);
            expect(result.matches.some((font) => font.status === 'loaded'),
                `offline Noto weight ${result.weight} should be loaded`).toBe(true);
        }
    } finally {
        await context.setOffline(false);
    }
});
