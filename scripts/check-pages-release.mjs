import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CACHE_NAME_PATTERN,
    CORE_ASSETS,
    PRECACHE_REVISION_PATTERN,
    computePrecacheRevisionFrom,
    extractServiceWorkerContract
} from './pages-contract.mjs';

export const DEFAULT_PAGES_URL = 'https://135179ylh-prog.github.io/cplayer-online/';
export const BUILD_META_MARKER = 'name="cplayer-build-meta" content="./build-meta.json"';
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Every check below compares the public release contract only. build-meta.json,
// sw.js, index.html and the pre-cached assets carry no credentials, so the
// report can be recorded verbatim in a task document.
export function assertDeployedMetadata(metadata, options = {}) {
    const failures = [];
    if (metadata?.schema !== 1) {
        failures.push(`build-meta.json schema is not 1: ${JSON.stringify(metadata?.schema ?? null)}`);
    }
    if (!COMMIT_PATTERN.test(String(metadata?.commit || ''))) {
        failures.push(`build-meta.json commit is not a full commit id: ${metadata?.commit || '(missing)'}`);
    }
    if (!CACHE_NAME_PATTERN.test(String(metadata?.cacheName || ''))) {
        failures.push(`build-meta.json cache name is invalid: ${metadata?.cacheName || '(missing)'}`);
    }
    if (!PRECACHE_REVISION_PATTERN.test(String(metadata?.precacheRevision || ''))) {
        failures.push(`build-meta.json pre-cache revision is invalid: ${metadata?.precacheRevision || '(missing)'}`);
    }
    const assets = Array.isArray(metadata?.precacheAssets) ? [...metadata.precacheAssets] : [];
    if (JSON.stringify(assets.sort()) !== JSON.stringify([...CORE_ASSETS].sort())) {
        failures.push('build-meta.json pre-cache assets do not match scripts/pages-contract.mjs');
    }
    if (options.expectedCommit && String(metadata?.commit || '') !== options.expectedCommit) {
        failures.push(`deployed commit ${metadata?.commit || '(missing)'} is not the expected ${options.expectedCommit}`);
    }
    return failures;
}

export function assertDeployedWorker(source, metadata) {
    const failures = [];
    const contract = extractServiceWorkerContract(source);
    if (contract.cacheName !== metadata?.cacheName) {
        failures.push(`deployed sw.js cache name ${contract.cacheName || '(missing)'} != build-meta ${metadata?.cacheName || '(missing)'}`);
    }
    if (contract.precacheRevision !== metadata?.precacheRevision) {
        failures.push(`deployed sw.js pre-cache revision ${contract.precacheRevision || '(missing)'} != build-meta ${metadata?.precacheRevision || '(missing)'}`);
    }
    if (JSON.stringify(contract.coreAssets) !== JSON.stringify([...CORE_ASSETS])) {
        failures.push('deployed sw.js CORE_ASSETS does not match scripts/pages-contract.mjs');
    }
    return failures;
}

export function assertRuntimeEvidence(evidence, metadata) {
    const failures = [];
    if (evidence.cplayerReady !== 'true') {
        failures.push(`page did not report cplayerReady: ${evidence.cplayerReady || '(missing)'}`);
    }
    if (!evidence.buildMetaMarker) {
        failures.push('page is missing the cplayer-build-meta marker');
    }
    if (!/\/sw\.js$/.test(String(evidence.controllerScriptUrl || ''))) {
        failures.push(`page is not controlled by the deployed Worker: ${evidence.controllerScriptUrl || '(no controller)'}`);
    }
    if (evidence.activeWorkerState !== 'activated') {
        failures.push(`active Worker state is not activated: ${evidence.activeWorkerState || '(missing)'}`);
    }
    const cacheKeys = Array.isArray(evidence.cacheKeys) ? evidence.cacheKeys : [];
    if (JSON.stringify(cacheKeys) !== JSON.stringify([metadata.cacheName])) {
        failures.push(`CacheStorage holds ${JSON.stringify(cacheKeys)} instead of only ${metadata.cacheName}`);
    }
    const cachedAssets = Array.isArray(evidence.cachedCoreAssets) ? evidence.cachedCoreAssets : [];
    const missing = CORE_ASSETS
        .map((asset) => asset.replace(/^\.\//, ''))
        .filter((asset) => !cachedAssets.some((cached) => cached.endsWith(`/${asset}`)));
    if (missing.length) {
        failures.push(`cached core assets are incomplete, missing: ${missing.join(', ')}`);
    }
    return failures;
}

function joinUrl(baseUrl, path) {
    return new URL(path.replace(/^\.\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function fetchFresh(url, bust) {
    const target = new URL(url);
    target.searchParams.set('release-check', bust);
    const response = await fetch(target, { cache: 'no-store', redirect: 'follow' });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response;
}

const CHROME_CANDIDATES = Object.freeze({
    win32: (env) => [
        `${env['ProgramFiles'] || 'C:/Program Files'}/Google/Chrome/Application/chrome.exe`,
        `${env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'}/Google/Chrome/Application/chrome.exe`,
        `${env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`
    ],
    darwin: () => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: () => ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
});

export function findChromeExecutable(env = process.env, platform = process.platform) {
    if (env.CPLAYER_CHROME_PATH) return env.CPLAYER_CHROME_PATH;
    const buildCandidates = CHROME_CANDIDATES[platform];
    if (!buildCandidates) {
        throw new Error(`Chrome was not found: unsupported platform ${platform}. Set CPLAYER_CHROME_PATH.`);
    }
    const found = buildCandidates(env).find((candidate) => candidate && existsSync(candidate));
    if (!found) {
        throw new Error('Chrome was not found. Set CPLAYER_CHROME_PATH to the browser executable.');
    }
    return found;
}

async function waitForDebuggerEndpoint(port, deadline) {
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return (await response.json()).webSocketDebuggerUrl;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    throw new Error(`Chrome did not expose a debugging endpoint on port ${port}: ${lastError?.message || 'timeout'}`);
}

// A very small CDP client. Using the protocol directly keeps online acceptance
// independent of any browser extension or long-lived user profile.
class CdpSession {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            if (!message.id) return;
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            if (message.error) entry.reject(new Error(`${message.method}: ${message.error.message}`));
            else entry.resolve(message.result);
        });
        socket.addEventListener('close', () => {
            for (const entry of this.pending.values()) entry.reject(new Error('CDP socket closed'));
            this.pending.clear();
        });
    }

    static async connect(webSocketUrl) {
        const socket = new WebSocket(webSocketUrl);
        await new Promise((resolveOpen, rejectOpen) => {
            socket.addEventListener('open', resolveOpen, { once: true });
            socket.addEventListener('error', () => rejectOpen(new Error('CDP socket failed to open')), { once: true });
        });
        return new CdpSession(socket);
    }

    send(method, params = {}, sessionId = undefined) {
        const id = this.nextId++;
        const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
        this.socket.send(JSON.stringify(payload));
        return new Promise((resolveCall, rejectCall) => {
            this.pending.set(id, { method, resolve: resolveCall, reject: rejectCall });
        });
    }

    close() {
        try {
            this.socket.close();
        } catch (error) {
            // The browser process is torn down next, so a failed close is not fatal.
        }
    }
}

async function evaluate(session, sessionId, expression) {
    const result = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
        throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
}

const RUNTIME_EVIDENCE_EXPRESSION = `(async () => {
    const container = navigator.serviceWorker;
    const registration = container ? await container.getRegistration() : null;
    const cacheKeys = self.caches ? (await caches.keys()).sort() : [];
    const current = cacheKeys.find((name) => name.startsWith('cplayer5-'));
    const cachedCoreAssets = current
        ? (await (await caches.open(current)).keys()).map((request) => new URL(request.url).pathname).sort()
        : [];
    return {
        cplayerReady: document.documentElement.dataset.cplayerReady || '',
        readyState: document.readyState,
        buildMetaMarker: Boolean(document.querySelector('meta[name="cplayer-build-meta"][content="./build-meta.json"]')),
        buildBadge: (document.getElementById('buildBadge')?.textContent || '').trim(),
        controllerScriptUrl: container?.controller?.scriptURL || '',
        activeWorkerState: registration?.active?.state || '',
        cacheKeys,
        cachedCoreAssets
    };
})()`;

export function isRuntimeEvidenceComplete(evidence) {
    return Boolean(evidence)
        && evidence.cplayerReady === 'true'
        && Boolean(evidence.controllerScriptUrl)
        && evidence.activeWorkerState === 'activated'
        && Array.isArray(evidence.cachedCoreAssets)
        && evidence.cachedCoreAssets.length >= CORE_ASSETS.length;
}

async function collectRuntimeEvidence(pageUrl, options = {}) {
    // The deployed origin can be slow enough that a single shared budget starves
    // the reload pass. Each wait gets its own deadline so a slow first load never
    // turns into a misreported acceptance failure.
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 240_000;
    const executable = findChromeExecutable();
    const profileDirectory = await mkdtemp(resolve(tmpdir(), 'cplayer-release-cdp-'));
    let chrome = null;
    let session = null;
    try {
        chrome = spawn(executable, [
            '--headless=new',
            '--remote-debugging-port=0',
            `--user-data-dir=${profileDirectory}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-component-update',
            '--disable-sync',
            '--window-size=1280,800',
            'about:blank'
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let chromeStderr = '';
        chrome.stderr.on('data', (chunk) => { chromeStderr += String(chunk); });

        const port = await waitForDebuggerPort(profileDirectory, chrome, Date.now() + 30_000, () => chromeStderr);
        const browserWebSocketUrl = await waitForDebuggerEndpoint(port, Date.now() + 30_000);
        session = await CdpSession.connect(browserWebSocketUrl);

        const { targetId } = await session.send('Target.createTarget', { url: pageUrl });
        const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });

        let evidence = await pollRuntimeEvidence(session, sessionId, timeoutMs);
        if (!isRuntimeEvidenceComplete(evidence)) {
            // A first visit installs the Worker after the page loads. One reload
            // proves the deployed Worker actually took control of a real client.
            await evaluate(session, sessionId, 'location.reload()').catch(() => {});
            evidence = await pollRuntimeEvidence(session, sessionId, timeoutMs, evidence);
        }
        await session.send('Target.closeTarget', { targetId }).catch(() => {});
        return evidence;
    } finally {
        if (session) session.close();
        if (chrome && chrome.exitCode === null) {
            chrome.kill();
            await new Promise((resolveExit) => {
                const timer = setTimeout(() => {
                    chrome.kill('SIGKILL');
                    resolveExit();
                }, 4_000);
                chrome.once('exit', () => {
                    clearTimeout(timer);
                    resolveExit();
                });
            });
        }
        await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5 });
    }
}

async function waitForDebuggerPort(profileDirectory, chrome, deadline, readStderr) {
    const portFile = resolve(profileDirectory, 'DevToolsActivePort');
    while (Date.now() < deadline) {
        if (chrome.exitCode !== null) {
            throw new Error(`Chrome exited early with code ${chrome.exitCode}: ${readStderr().trim().slice(-400)}`);
        }
        if (existsSync(portFile)) {
            // On Windows this read races Chrome still writing the file and throws
            // EBUSY. That is "not ready yet", not a failure, so keep polling
            // instead of aborting the whole acceptance run.
            try {
                const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
                if (Number.isInteger(port) && port > 0) return port;
            } catch (error) {
                if (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'ENOENT') throw error;
            }
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    throw new Error('Chrome did not publish a DevToolsActivePort file in time');
}

async function pollRuntimeEvidence(session, sessionId, timeoutMs, fallback = null) {
    const deadline = Date.now() + timeoutMs;
    let last = fallback;
    while (Date.now() < deadline) {
        const current = await evaluate(session, sessionId, RUNTIME_EVIDENCE_EXPRESSION).catch(() => null);
        if (current) last = current;
        if (isRuntimeEvidenceComplete(current)) return current;
        await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    }
    if (!last) throw new Error('the deployed page never became evaluable over CDP');
    return last;
}

export function parseReleaseArgs(argv) {
    const options = { url: DEFAULT_PAGES_URL, expectedCommit: '', reportPath: '', skipBrowser: false, unknown: [] };
    for (const argument of argv) {
        const separator = argument.indexOf('=');
        const [flag, value] = separator > 0
            ? [argument.slice(0, separator), argument.slice(separator + 1)]
            : [argument, ''];
        if (flag === '--url') options.url = value || options.url;
        else if (flag === '--commit') options.expectedCommit = value.trim().toLowerCase();
        else if (flag === '--report') options.reportPath = value;
        else if (flag === '--no-browser') options.skipBrowser = true;
        else options.unknown.push(argument);
    }
    return options;
}

export async function checkPagesRelease(options = {}) {
    const pageUrl = options.url || DEFAULT_PAGES_URL;
    const bust = String(Date.now());
    const failures = [];
    const checks = [];

    const metadata = await (await fetchFresh(joinUrl(pageUrl, 'build-meta.json'), bust)).json();
    const metadataFailures = assertDeployedMetadata(metadata, { expectedCommit: options.expectedCommit });
    failures.push(...metadataFailures);
    checks.push({ name: 'build-meta.json contract', passed: metadataFailures.length === 0 });

    const workerSource = await (await fetchFresh(joinUrl(pageUrl, 'sw.js'), bust)).text();
    const workerFailures = assertDeployedWorker(workerSource, metadata);
    failures.push(...workerFailures);
    checks.push({ name: 'deployed sw.js agrees with build-meta.json', passed: workerFailures.length === 0 });

    const indexSource = await (await fetchFresh(joinUrl(pageUrl, 'index.html'), bust)).text();
    const markerPresent = indexSource.includes(BUILD_META_MARKER);
    if (!markerPresent) failures.push('deployed index.html is missing the cplayer-build-meta marker');
    checks.push({ name: 'deployed index.html advertises build metadata', passed: markerPresent });

    // Recompute the pre-cache hash from the bytes the origin actually serves.
    // A matching hash is what proves the deployment is byte-identical to the
    // verified artifact, not merely that the workflow reported success.
    const servedRevision = await computePrecacheRevisionFrom(async (asset) => {
        const response = await fetchFresh(joinUrl(pageUrl, asset), bust);
        return Buffer.from(await response.arrayBuffer());
    });
    const revisionMatches = servedRevision === metadata.precacheRevision;
    if (!revisionMatches) {
        failures.push(`served core assets hash to ${servedRevision}, but build-meta declares ${metadata.precacheRevision}`);
    }
    checks.push({ name: 'served core assets reproduce the pre-cache hash', passed: revisionMatches });

    let runtime = null;
    if (!options.skipBrowser) {
        runtime = await collectRuntimeEvidence(joinUrl(pageUrl, 'index.html'), options);
        const runtimeFailures = assertRuntimeEvidence(runtime, metadata);
        failures.push(...runtimeFailures);
        checks.push({ name: 'direct CDP runtime evidence', passed: runtimeFailures.length === 0 });
    }

    return {
        pageUrl,
        checkedAt: new Date().toISOString(),
        commit: metadata.commit,
        cacheName: metadata.cacheName,
        precacheRevision: metadata.precacheRevision,
        servedPrecacheRevision: servedRevision,
        coreAssetCount: CORE_ASSETS.length,
        runtime: runtime && {
            cplayerReady: runtime.cplayerReady,
            readyState: runtime.readyState,
            buildBadge: runtime.buildBadge,
            buildMetaMarker: runtime.buildMetaMarker,
            controllerIsDeployedWorker: /\/sw\.js$/.test(String(runtime.controllerScriptUrl || '')),
            activeWorkerState: runtime.activeWorkerState,
            cacheKeys: runtime.cacheKeys,
            cachedCoreAssetCount: runtime.cachedCoreAssets.length
        },
        checks,
        failures
    };
}

async function main(argv) {
    const options = parseReleaseArgs(argv);
    if (options.unknown.length) {
        console.error(`Unknown option: ${options.unknown.join(' ')}`);
        console.error('Usage: node scripts/check-pages-release.mjs [--url=<pages-url>] [--commit=<sha>] [--report=<path>] [--no-browser]');
        process.exit(2);
    }

    const result = await checkPagesRelease(options);
    for (const check of result.checks) {
        process.stdout.write(`${check.passed ? 'pass' : 'FAIL'}  ${check.name}\n`);
    }
    process.stdout.write(`\ncommit: ${result.commit}\n`);
    process.stdout.write(`cache: ${result.cacheName}\n`);
    process.stdout.write(`precache: ${result.precacheRevision}\n`);
    process.stdout.write(`served precache: ${result.servedPrecacheRevision}\n`);
    if (result.runtime) {
        process.stdout.write(`page: ready=${result.runtime.cplayerReady} badge=${result.runtime.buildBadge} worker=${result.runtime.activeWorkerState}\n`);
        process.stdout.write(`caches: ${JSON.stringify(result.runtime.cacheKeys)} core=${result.runtime.cachedCoreAssetCount}/${result.coreAssetCount}\n`);
    }

    const reportPath = options.reportPath
        ? resolve(PROJECT_ROOT, options.reportPath)
        : resolve(PROJECT_ROOT, 'output', 'pages-release-check.json');
    await mkdir(resolve(reportPath, '..'), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`report: ${reportPath}\n`);

    if (result.failures.length) {
        console.error(`\nOnline release check failed:\n- ${result.failures.join('\n- ')}`);
        process.exit(1);
    }
    process.stdout.write('\nOnline release check passed.\n');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    await main(process.argv.slice(2));
}
