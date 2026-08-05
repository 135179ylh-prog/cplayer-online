import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This is the single source for the runtime files that must be available to the
// offline app shell. build-pages-artifact.mjs verifies that sw.js agrees with it.
export const CORE_ASSETS = Object.freeze([
    './index.html',
    './playlist.js',
    './css/all.min.css',
    './css/noto-sans-sc.css',
    './css/tailwind.css',
    './js/color-thief.umd.js',
    './js/cloud-config.js',
    './js/cloud-sync.js',
    './js/vendor/supabase.js',
    './js/app.js',
    './js/core-utils.js',
    './img/icon.svg',
    './img/icon.png',
    './manifest.json'
]);

export const CACHE_NAME_PATTERN = /^cplayer5-v\d+-reliability-sprint$/;
export const PRECACHE_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export async function computePrecacheRevision(projectRoot) {
    const hash = createHash('sha256');
    for (const asset of [...CORE_ASSETS].sort()) {
        const content = await readFile(resolve(projectRoot, asset));
        hash.update(asset, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(content);
        hash.update('\0', 'utf8');
    }
    return `sha256:${hash.digest('hex')}`;
}

export function extractServiceWorkerContract(source) {
    const cacheName = source.match(/const CACHE_NAME = '([^']+)'/)?.[1] || '';
    const precacheRevision = source.match(/const PRECACHE_REVISION = '([^']+)'/)?.[1] || '';
    const assetsMatch = source.match(/const CORE_ASSETS = \[([\s\S]*?)\];/);
    const coreAssets = assetsMatch
        ? [...assetsMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
        : [];
    return { cacheName, precacheRevision, coreAssets };
}

export function assertServiceWorkerContract(source, computedRevision) {
    const contract = extractServiceWorkerContract(source);
    if (!CACHE_NAME_PATTERN.test(contract.cacheName)) {
        throw new Error(`Service Worker cache name is invalid: ${contract.cacheName || '(missing)'}`);
    }
    if (!PRECACHE_REVISION_PATTERN.test(contract.precacheRevision)) {
        throw new Error(`Service Worker pre-cache revision is invalid: ${contract.precacheRevision || '(missing)'}`);
    }
    if (contract.precacheRevision !== computedRevision) {
        throw new Error(
            `Service Worker pre-cache revision is stale: ${contract.precacheRevision} != ${computedRevision}`
        );
    }
    if (JSON.stringify(contract.coreAssets) !== JSON.stringify(CORE_ASSETS)) {
        throw new Error('Service Worker CORE_ASSETS does not match scripts/pages-contract.mjs');
    }
    return contract;
}
