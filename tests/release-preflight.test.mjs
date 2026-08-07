import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
    assertSafeOutputDirectory,
    buildPagesArtifact
} from '../scripts/build-pages-artifact.mjs';
import {
    checkRepositoryState,
    inspectRepositoryFile
} from '../scripts/check-repository-state.mjs';
import {
    assertRollbackVersion,
    extractDatabaseVersion,
    isTrustedDynamicRuntimeSource,
    readCurrentDatabaseVersion,
    readTargetDatabaseVersion
} from '../scripts/check-rollback-target.mjs';
import {
    CORE_ASSETS,
    assertServiceWorkerContract,
    computePrecacheRevision,
    computePrecacheRevisionFrom,
    extractServiceWorkerContract
} from '../scripts/pages-contract.mjs';
import {
    STEPS,
    expireInterruptedSteps,
    formatStateReport,
    parseGateArgs,
    prepareRunState,
    resolveNpmCommand,
    selectSteps,
    summarizeRunOutcome
} from '../scripts/run-quality-gate.mjs';
import {
    BUILD_META_MARKER,
    DEFAULT_PAGES_URL,
    assertDeployedMetadata,
    assertDeployedWorker,
    assertRuntimeEvidence,
    findChromeExecutable,
    isRuntimeEvidenceComplete,
    parseReleaseArgs
} from '../scripts/check-pages-release.mjs';

function runGit(cwd, args, options = {}) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        input: options.input
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
}

test('Pages output guard accepts only the exact project Pages directory', () => {
    const root = resolve('CPlayer-test-root');
    assert.equal(
        assertSafeOutputDirectory(resolve(root, 'output', 'pages'), root),
        resolve(root, 'output', 'pages')
    );
    assert.throws(() => assertSafeOutputDirectory(root, root), /unsafe Pages output/);
    assert.throws(() => assertSafeOutputDirectory(resolve(root, 'output'), root), /unsafe Pages output/);
    assert.throws(() => assertSafeOutputDirectory(resolve(root, '..', 'elsewhere'), root), /unsafe Pages output/);
    if (process.platform === 'win32') {
        assert.throws(() => assertSafeOutputDirectory('Z:\\outside-pages', root), /unsafe Pages output/);
    }
});

test('Pages builder rejects a linked output root before deleting external data', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'cplayer-pages-'));
    const projectRoot = resolve(sandbox, 'project');
    const externalRoot = resolve(sandbox, 'external-output');
    const sentinel = resolve(externalRoot, 'pages', 'sentinel.txt');
    try {
        await mkdir(projectRoot, { recursive: true });
        await mkdir(resolve(externalRoot, 'pages'), { recursive: true });
        await writeFile(sentinel, 'keep', 'utf8');
        await symlink(externalRoot, resolve(projectRoot, 'output'), process.platform === 'win32' ? 'junction' : 'dir');

        await assert.rejects(
            buildPagesArtifact({ projectRoot }),
            /linked Pages output root|resolves outside the project/
        );
        assert.equal(await readFile(sentinel, 'utf8'), 'keep');
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});

test('Pages pre-cache contract matches sw.js and hashes its actual runtime assets', async () => {
    const projectRoot = resolve('.');
    const swSource = await readFile(resolve(projectRoot, 'sw.js'), 'utf8');
    const revision = await computePrecacheRevision(projectRoot);
    const contract = extractServiceWorkerContract(swSource);

    assert.equal(contract.coreAssets.length, CORE_ASSETS.length);
    assert.deepEqual(contract.coreAssets, CORE_ASSETS);
    assert.equal(contract.precacheRevision, revision);
    assertServiceWorkerContract(swSource, revision);

    const artifact = await buildPagesArtifact({ projectRoot });
    assert.equal(await computePrecacheRevision(artifact.outputDirectory), revision);
});

test('quality gate exposes every layer as a selectable, resumable step', () => {
    const expectedIds = [
        'build-css', 'build-cloud-vendor', 'test-unit', 'check-module', 'check-sw',
        'check-features', 'audit', 'build-pages', 'test-e2e', 'check-repo'
    ];
    assert.deepEqual(STEPS.map((step) => step.id), expectedIds);
    assert.equal(STEPS.filter((step) => step.pagesRoot).map((step) => step.id).join(','), 'test-e2e');
    assert.deepEqual(STEPS.filter((step) => step.guard).map((step) => step.guard), ['css', 'cloud-vendor']);

    assert.deepEqual(parseGateArgs([]), { mode: 'run', only: [], from: '', resume: false, unknown: [] });
    assert.equal(parseGateArgs(['--list']).mode, 'list');
    assert.equal(parseGateArgs(['--status']).mode, 'status');
    assert.equal(parseGateArgs(['--resume']).resume, true);
    assert.deepEqual(parseGateArgs(['--only=check-sw,test-unit']).only, ['check-sw', 'test-unit']);
    assert.deepEqual(parseGateArgs(['--bogus']).unknown, ['--bogus']);

    assert.deepEqual(selectSteps(STEPS, parseGateArgs([])).map((step) => step.id), expectedIds);
    assert.deepEqual(
        selectSteps(STEPS, parseGateArgs(['--only=test-e2e,check-repo'])).map((step) => step.id),
        ['test-e2e', 'check-repo']
    );
    assert.deepEqual(
        selectSteps(STEPS, parseGateArgs(['--from=build-pages'])).map((step) => step.id),
        ['build-pages', 'test-e2e', 'check-repo']
    );
    assert.throws(() => selectSteps(STEPS, parseGateArgs(['--only=nope'])), /Unknown quality gate step/);
    assert.throws(() => selectSteps(STEPS, parseGateArgs(['--from=nope'])), /Unknown quality gate step/);
});

test('an outer timeout is reported as interrupted rather than a test failure', () => {
    const state = {
        schema: 1,
        steps: {
            'test-unit': { status: 'passed', exitCode: 0, durationMs: 1500 },
            'test-e2e': { status: 'running', pid: 424242, exitCode: null }
        }
    };
    assert.equal(expireInterruptedSteps(state, () => false), 1);
    assert.equal(state.steps['test-e2e'].status, 'interrupted');
    assert.equal(state.steps['test-unit'].status, 'passed');
    assert.ok(state.steps['test-e2e'].finishedAt);

    const liveState = { schema: 1, steps: { 'test-e2e': { status: 'running', pid: process.pid } } };
    assert.equal(expireInterruptedSteps(liveState, () => true), 0);
    assert.equal(liveState.steps['test-e2e'].status, 'running');

    const report = formatStateReport(state);
    assert.match(report, /03\/10 test-unit\s+passed 1\.5s exit=0/);
    assert.match(report, /09\/10 test-e2e\s+interrupted/);
    assert.match(report, /01\/10 build-css\s+not run/);
});

test('a full run starts from a clean state while resume and subsets keep history', () => {
    const previous = {
        schema: 1,
        startedAt: '2026-08-05T00:00:00.000Z',
        steps: { 'test-unit': { status: 'passed', exitCode: 0 } }
    };
    const fullRun = prepareRunState(previous, parseGateArgs([]), [...STEPS]);
    assert.deepEqual(fullRun.steps, {});
    assert.notEqual(fullRun.startedAt, previous.startedAt);

    assert.equal(prepareRunState(previous, parseGateArgs(['--resume']), [...STEPS]), previous);
    assert.equal(
        prepareRunState(previous, parseGateArgs(['--only=test-unit']), selectSteps(STEPS, parseGateArgs(['--only=test-unit']))),
        previous
    );
});

test('only a full run may claim the gate passed', () => {
    const allPassed = { schema: 1, steps: {} };
    for (const step of STEPS) allPassed.steps[step.id] = { status: 'passed', exitCode: 0 };

    assert.equal(summarizeRunOutcome(allPassed, parseGateArgs([])), 'Quality gate passed.');
    assert.equal(summarizeRunOutcome(allPassed, parseGateArgs(['--resume'])), 'Quality gate passed.');

    // A subset run must not inherit a full pass from earlier state history.
    for (const subset of [['--only=test-unit'], ['--from=check-repo']]) {
        const summary = summarizeRunOutcome(allPassed, parseGateArgs(subset));
        assert.match(summary, /covered only a subset/);
        assert.doesNotMatch(summary, /^Quality gate passed\.$/);
    }

    const partial = { schema: 1, steps: { 'test-unit': { status: 'passed' } } };
    assert.match(summarizeRunOutcome(partial, parseGateArgs([])), /Run npm run verify for the full gate/);
});

test('quality gate layers run npm without shell escaping', () => {
    const fromEnv = resolveNpmCommand({ npm_execpath: '/npm/bin/npm-cli.js' }, '/usr/bin/node');
    assert.deepEqual(fromEnv, { command: '/usr/bin/node', prefixArgs: ['/npm/bin/npm-cli.js'], shell: false });

    // This runner always has a bundled npm, on the Windows layout beside the
    // binary or the POSIX layout under lib/. Either must resolve without a shell.
    const discovered = resolveNpmCommand({}, process.execPath);
    assert.equal(discovered.shell, false);
    assert.equal(discovered.command, process.execPath);
    assert.match(discovered.prefixArgs[0], /npm-cli\.js$/);
    assert.equal(existsSync(discovered.prefixArgs[0]), true);
});

test('npm discovery handles both install layouts without matching a sibling tree', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'cplayer-npm-layout-'));
    try {
        for (const directory of [
            'posix/bin', 'posix/lib/node_modules/npm/bin',
            'win/node_modules/npm/bin', 'bare/bin'
        ]) {
            await mkdir(resolve(sandbox, directory), { recursive: true });
        }
        await writeFile(resolve(sandbox, 'posix/lib/node_modules/npm/bin/npm-cli.js'), '', 'utf8');
        await writeFile(resolve(sandbox, 'win/node_modules/npm/bin/npm-cli.js'), '', 'utf8');

        const posix = resolveNpmCommand({}, resolve(sandbox, 'posix/bin/node'));
        assert.equal(posix.shell, false);
        assert.equal(posix.prefixArgs[0], resolve(sandbox, 'posix/lib/node_modules/npm/bin/npm-cli.js'));

        const windows = resolveNpmCommand({}, resolve(sandbox, 'win/node.exe'));
        assert.equal(windows.shell, false);
        assert.equal(windows.prefixArgs[0], resolve(sandbox, 'win/node_modules/npm/bin/npm-cli.js'));

        // A binary with no bundled npm must fall back instead of borrowing the
        // npm that belongs to an unrelated sibling install.
        const bare = resolveNpmCommand({}, resolve(sandbox, 'bare/bin/node'));
        assert.deepEqual(bare, { command: 'npm', prefixArgs: [], shell: process.platform === 'win32' });
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});

function deployedMetadata(overrides = {}) {
    return {
        schema: 1,
        commit: 'a'.repeat(40),
        cacheName: 'cplayer5-v85-reliability-sprint',
        precacheRevision: `sha256:${'b'.repeat(64)}`,
        precacheAssets: [...CORE_ASSETS],
        generatedAt: '2026-08-06T00:00:00.000Z',
        ...overrides
    };
}

test('online release check rejects a deployment that does not match the release contract', () => {
    assert.deepEqual(assertDeployedMetadata(deployedMetadata()), []);
    assert.deepEqual(
        assertDeployedMetadata(deployedMetadata(), { expectedCommit: 'a'.repeat(40) }),
        []
    );
    assert.match(
        assertDeployedMetadata(deployedMetadata(), { expectedCommit: 'c'.repeat(40) }).join('\n'),
        /is not the expected/
    );
    assert.match(assertDeployedMetadata(deployedMetadata({ schema: 2 })).join('\n'), /schema is not 1/);
    assert.match(assertDeployedMetadata(deployedMetadata({ commit: 'abc' })).join('\n'), /not a full commit id/);
    assert.match(assertDeployedMetadata(deployedMetadata({ cacheName: 'cplayer5-v85' })).join('\n'), /cache name is invalid/);
    assert.match(assertDeployedMetadata(deployedMetadata({ precacheRevision: 'sha256:short' })).join('\n'), /revision is invalid/);
    assert.match(
        assertDeployedMetadata(deployedMetadata({ precacheAssets: CORE_ASSETS.slice(1) })).join('\n'),
        /pre-cache assets do not match/
    );
    assert.equal(assertDeployedMetadata(null).length >= 4, true);
});

test('online release check compares the deployed Worker with the published metadata', () => {
    const metadata = deployedMetadata();
    const source = [
        `const CACHE_NAME = '${metadata.cacheName}';`,
        `const PRECACHE_REVISION = '${metadata.precacheRevision}';`,
        `const CORE_ASSETS = [\n${CORE_ASSETS.map((asset) => `  '${asset}'`).join(',\n')}\n];`
    ].join('\n');
    assert.deepEqual(assertDeployedWorker(source, metadata), []);
    assert.match(
        assertDeployedWorker(source, deployedMetadata({ cacheName: 'cplayer5-v84-reliability-sprint' })).join('\n'),
        /cache name .* != build-meta/
    );
    assert.match(
        assertDeployedWorker(source, deployedMetadata({ precacheRevision: `sha256:${'c'.repeat(64)}` })).join('\n'),
        /pre-cache revision .* != build-meta/
    );
    assert.match(
        assertDeployedWorker(source.replace(`  '${CORE_ASSETS[0]}',\n`, ''), metadata).join('\n'),
        /CORE_ASSETS does not match/
    );
});

function runtimeEvidence(overrides = {}) {
    const metadata = deployedMetadata();
    return {
        cplayerReady: 'true',
        readyState: 'complete',
        buildMetaMarker: true,
        buildBadge: 'v85',
        controllerScriptUrl: 'https://example.invalid/cplayer-online/sw.js',
        activeWorkerState: 'activated',
        cacheKeys: [metadata.cacheName],
        cachedCoreAssets: CORE_ASSETS.map((asset) => `/cplayer-online/${asset.replace('./', '')}`),
        ...overrides
    };
}

test('online release check requires real runtime propagation, not a successful workflow', () => {
    const metadata = deployedMetadata();
    assert.deepEqual(assertRuntimeEvidence(runtimeEvidence(), metadata), []);
    assert.equal(isRuntimeEvidenceComplete(runtimeEvidence()), true);

    assert.match(assertRuntimeEvidence(runtimeEvidence({ cplayerReady: '' }), metadata).join('\n'), /did not report cplayerReady/);
    assert.match(assertRuntimeEvidence(runtimeEvidence({ buildMetaMarker: false }), metadata).join('\n'), /missing the cplayer-build-meta marker/);
    assert.match(
        assertRuntimeEvidence(runtimeEvidence({ controllerScriptUrl: '' }), metadata).join('\n'),
        /not controlled by the deployed Worker/
    );
    assert.match(
        assertRuntimeEvidence(runtimeEvidence({ activeWorkerState: 'installing' }), metadata).join('\n'),
        /not activated/
    );
    // The propagation bug this guards: a successful deployment while the client
    // still holds the previous release's cache.
    assert.match(
        assertRuntimeEvidence(runtimeEvidence({ cacheKeys: ['cplayer5-v84-reliability-sprint'] }), metadata).join('\n'),
        /CacheStorage holds .* instead of only cplayer5-v85-reliability-sprint/
    );
    assert.match(
        assertRuntimeEvidence(runtimeEvidence({ cachedCoreAssets: [] }), metadata).join('\n'),
        /cached core assets are incomplete/
    );
    for (const incomplete of [
        { cplayerReady: '' },
        { controllerScriptUrl: '' },
        { activeWorkerState: 'installing' },
        { cachedCoreAssets: CORE_ASSETS.slice(1).map((asset) => `/${asset.replace('./', '')}`) }
    ]) {
        assert.equal(isRuntimeEvidenceComplete(runtimeEvidence(incomplete)), false);
    }
    assert.equal(isRuntimeEvidenceComplete(null), false);
});

test('online release check owns its public target, options, and browser discovery', () => {
    assert.equal(DEFAULT_PAGES_URL, 'https://135179ylh-prog.github.io/cplayer-online/');
    assert.equal(BUILD_META_MARKER, 'name="cplayer-build-meta" content="./build-meta.json"');
    assert.equal(
        readFileSync(resolve('index.html'), 'utf8').includes(BUILD_META_MARKER),
        true
    );

    assert.deepEqual(parseReleaseArgs([]), {
        url: DEFAULT_PAGES_URL,
        expectedCommit: '',
        reportPath: '',
        skipBrowser: false,
        unknown: []
    });
    const parsed = parseReleaseArgs([
        '--url=https://example.invalid/app/',
        '--commit=ABCDEF1234567890ABCDEF1234567890ABCDEF12',
        '--report=output/custom.json',
        '--no-browser'
    ]);
    assert.equal(parsed.url, 'https://example.invalid/app/');
    assert.equal(parsed.expectedCommit, 'abcdef1234567890abcdef1234567890abcdef12');
    assert.equal(parsed.reportPath, 'output/custom.json');
    assert.equal(parsed.skipBrowser, true);
    assert.deepEqual(parseReleaseArgs(['--nope']).unknown, ['--nope']);

    // An explicit override wins on every platform, and an unknown platform must
    // fail loudly instead of silently probing another platform's paths.
    assert.equal(
        findChromeExecutable({ CPLAYER_CHROME_PATH: 'C:/custom/chrome.exe' }, 'win32'),
        'C:/custom/chrome.exe'
    );
    assert.equal(
        findChromeExecutable({ CPLAYER_CHROME_PATH: '/opt/chrome' }, 'unsupported-platform'),
        '/opt/chrome'
    );
    assert.throws(
        () => findChromeExecutable({}, 'unsupported-platform'),
        /unsupported platform unsupported-platform/
    );
    assert.throws(
        () => findChromeExecutable({ ProgramFiles: '/nonexistent-cplayer-probe' }, 'win32'),
        /Chrome was not found/
    );
});

test('pre-cache revision can be recomputed from an arbitrary asset source', async () => {
    const projectRoot = resolve('.');
    const local = await computePrecacheRevision(projectRoot);
    const served = await computePrecacheRevisionFrom((asset) => readFile(resolve(projectRoot, asset)));
    assert.equal(served, local);

    const tampered = await computePrecacheRevisionFrom(async (asset) => {
        const bytes = await readFile(resolve(projectRoot, asset));
        return asset === './manifest.json' ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes;
    });
    assert.notEqual(tampered, local);
});

test('rollback version extraction supports current and legacy database declarations', () => {
    const currentSource = [
        "const DB_NAME = 'CPlayer5DB';",
        'const DB_VERSION = 4;',
        'indexedDB.open(DB_NAME, DB_VERSION);',
        "const escapeQuote = (value) => value.replace(/\"/g, '&quot;');",
        'const laterTemplate = `font: "Example"`;'
    ].join('\n');
    assert.equal(extractDatabaseVersion(currentSource), 4);
    assert.equal(extractDatabaseVersion("indexedDB.open('CPlayer5DB', 3)"), 3);
    assert.equal(extractDatabaseVersion('const unrelated = 4;'), null);
});

test('rollback version extraction ignores comments and strings and rejects ambiguity', () => {
    const source = `
        // const DB_VERSION = 4;
        const decoy = "const DB_VERSION = 9; indexedDB.open('CPlayer5DB', 9)";
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 3;
        indexedDB.open(DB_NAME, DB_VERSION);
    `;
    assert.equal(extractDatabaseVersion(source), 3);
    assert.throws(() => extractDatabaseVersion(`
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 4;
        const DB_VERSION = 3;
        indexedDB.open(DB_NAME, DB_VERSION);
    `), /could not be parsed|multiple DB_VERSION/);
    assert.throws(() => extractDatabaseVersion(`
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 4;
        indexedDB.open(DB_NAME, 3);
    `), /not wired/);
});

test('rollback version extraction ignores regex decoys without swallowing division', () => {
    const source = `
        const decoy = /indexedDB.open('CPlayer5DB', 4)/;
        const escapedQuote = value.replace(/"/g, '&quot;');
        const ratio = total / count;
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 3;
        request = indexedDB.open(DB_NAME, DB_VERSION);
    `;
    assert.equal(extractDatabaseVersion(source), 3);
});

test('rollback version extraction resolves scope and rejects conflicting CPlayer5DB opens', () => {
    assert.throws(() => extractDatabaseVersion(`
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 4;
        function unusedOtherDatabase() {
            const DB_NAME = 'OtherDB';
            const DB_VERSION = 4;
            indexedDB.open(DB_NAME, DB_VERSION);
        }
        indexedDB.open('CPlayer5DB', 3);
    `), /not wired|ambiguous/);

    assert.throws(() => extractDatabaseVersion(`
        function unusedOldPath() {
            const DB_NAME = 'CPlayer5DB';
            const DB_VERSION = 4;
            indexedDB.open(DB_NAME, DB_VERSION);
        }
        indexedDB.open('CPlayer5DB', 3);
    `), /ambiguous/);
});

test('rollback version extraction handles HTML boundaries, defaults, and global IndexedDB forms', () => {
    assert.equal(extractDatabaseVersion(
        "const example = `<script>indexedDB.open('CPlayer5DB', 4)</script>`; indexedDB.open('CPlayer5DB', 3);"
    ), 3);
    assert.equal(extractDatabaseVersion(
        "<html><script>const DB_NAME = 'CPlayer5DB'; const DB_VERSION = 4; indexedDB.open(DB_NAME, DB_VERSION);</script></html>",
        { sourceKind: 'html' }
    ), 4);
    assert.throws(() => extractDatabaseVersion(`
        <body onload="indexedDB.open('CPlayer5DB', 3)">
            <script>indexedDB.open('CPlayer5DB', 4)</script>
        </body>
    `, { sourceKind: 'html' }), /ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        <a href="javascript:indexedDB.open('CPlayer5DB', 3)">restore</a>
        <script>indexedDB.open('CPlayer5DB', 4)</script>
    `, { sourceKind: 'html' }), /ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        <a href="java&#10;script:indexedDB.open('CPlayer5DB', 3)">restore</a>
        <script>indexedDB.open('CPlayer5DB', 4)</script>
    `, { sourceKind: 'html' }), /ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        <iframe srcdoc="<script>indexedDB.open(&quot;CPlayer5DB&quot;, 3)</script>"></iframe>
        <script>indexedDB.open('CPlayer5DB', 4)</script>
    `, { sourceKind: 'html' }), /ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        <script>const DB_VERSION = 4;</script>
        <iframe srcdoc="<script>window.DB_VERSION=3; indexedDB.open(&quot;CPlayer5DB&quot;, DB_VERSION)</script>"></iframe>
    `, { sourceKind: 'html' }), /unresolved|ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        <script>window.DB_VERSION = 3; indexedDB.open('CPlayer5DB', DB_VERSION)</script>
        <script>const DB_VERSION = 4;</script>
    `, { sourceKind: 'html' }), /unresolved|ambiguous/);
    for (const schedulingAttribute of ['defer', 'async']) {
        assert.throws(() => extractDatabaseVersion(`
            <script ${schedulingAttribute} src="late.js"></script>
            <script>window.DB_VERSION = 3; indexedDB.open('CPlayer5DB', DB_VERSION)</script>
        `, {
            sourceKind: 'html',
            loadScript: () => 'const DB_VERSION = 4;'
        }), /unresolved|ambiguous/);
    }
    assert.equal(extractDatabaseVersion(`
        <div data-example="javascript:indexedDB.open('CPlayer5DB', 3)"></div>
        <script>indexedDB.open('CPlayer5DB', 4)</script>
    `, { sourceKind: 'html' }), 4);
    assert.throws(() => extractDatabaseVersion(`
        function oldPath(value = indexedDB.open('CPlayer5DB', 3)) {}
        indexedDB.open('CPlayer5DB', 4);
    `), /ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        if (false) indexedDB.open('CPlayer5DB', 4);
        globalThis.indexedDB.open('CPlayer5DB', 3);
    `), /ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        indexedDB.open('CPlayer5DB', 4);
        unknownOwner.indexedDB.open('CPlayer5DB', 3);
    `), /unresolved/);
    assert.equal(extractDatabaseVersion(`
        function openLater() { indexedDB.open(DB_NAME, DB_VERSION); }
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 4;
        openLater();
    `), 4);
    assert.throws(() => extractDatabaseVersion(`
        function openDb(name = 'CPlayer5DB', version = 4) { indexedDB.open(name, version); }
        openDb();
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        function openDb(name = 'CPlayer5DB', version = 4) { indexedDB.open(name, version); }
        openDb('CPlayer5DB', 3);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        function staleV4() { indexedDB.open('CPlayer5DB', 4); }
        function openDb(factory = indexedDB, name = 'CPlayer5DB', version = 3) {
            factory.open(name, version);
        }
        openDb();
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        indexedDB.open('CPlayer5DB', 4);
        function openDb(owner, name, version) { owner.open(name, version); }
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        indexedDB.open('CPlayer5DB', 4);
        function openDb(owner, name) { owner.open(name, '3'); }
    `), /unresolved/);
    assert.equal(extractDatabaseVersion(`
        const xhr = new XMLHttpRequest();
        xhr.open('GET', getUrl(), true);
        caches.open(getCacheName());
        window.open('https://example.invalid/', '_blank');
        indexedDB.open('CPlayer5DB', 4);
    `), 4);
    assert.equal(extractDatabaseVersion(`
        function openExported() { indexedDB.open(DB_NAME, DB_VERSION); }
        export const DB_NAME = 'CPlayer5DB';
        export const DB_VERSION = 4;
    `), 4);
    assert.throws(() => extractDatabaseVersion(`
        const [DB_NAME = 'CPlayer5DB', DB_VERSION = 4] = [];
        indexedDB.open(DB_NAME, DB_VERSION);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        Object.prototype.version = 3;
        const { version = 4 } = {};
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        Array.prototype[0] = 3;
        const [version = 4] = [];
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        const [, version = 4] = [...[0, 3]];
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        const { version = 4 } = getConfig();
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        const options = { version: 3 };
        const { version = 4 } = options;
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.equal(extractDatabaseVersion(`
        const { version = 4 } = { version: 4, version: 3 };
        indexedDB.open('CPlayer5DB', version);
    `), 3);
    assert.throws(() => extractDatabaseVersion(`
        const base = { version: 3 };
        const { version = 4 } = { version: 4, ...base };
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        const base = { version: 3 };
        const { version = 4 } = { ...base };
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.equal(extractDatabaseVersion(`
        const key = 'version';
        const { version = 4 } = { [key]: 3 };
        indexedDB.open('CPlayer5DB', version);
    `), 3);
    assert.throws(() => extractDatabaseVersion(`
        const { version = 4 } = { __proto__: { version: 3 } };
        indexedDB.open('CPlayer5DB', version);
    `), /unresolved/);
    assert.equal(extractDatabaseVersion(`
        let DB_VERSION = 4;
        DB_VERSION = 3;
        indexedDB.open('CPlayer5DB', DB_VERSION);
    `), 3);
    for (const mutation of [
        'DB_VERSION--;',
        '({ version: DB_VERSION } = { version: 3 });',
        '[DB_VERSION] = [3];',
        "for (DB_VERSION of [3]) indexedDB.open('CPlayer5DB', DB_VERSION);",
        "if (true) { var DB_VERSION = 3; }"
    ]) {
        assert.throws(() => extractDatabaseVersion(`
            ${mutation.includes('var DB_VERSION') ? 'var' : 'let'} DB_VERSION = 4;
            ${mutation}
            indexedDB.open('CPlayer5DB', DB_VERSION);
        `), /unresolved|ambiguous/);
    }
    assert.equal(extractDatabaseVersion(`
        <script>
            var DB_VERSION = 4;
            globalThis.DB_VERSION = 3;
            indexedDB.open('CPlayer5DB', DB_VERSION);
        </script>
    `, { sourceKind: 'html' }), 3);
    assert.equal(extractDatabaseVersion(`
        <script>
            function localVersion() {
                var DB_VERSION = 3;
                globalThis.DB_VERSION = 4;
                indexedDB.open('CPlayer5DB', DB_VERSION);
            }
            localVersion();
        </script>
    `, { sourceKind: 'html' }), 3);
    assert.equal(extractDatabaseVersion(`
        <script type="module">
            var DB_VERSION = 3;
            globalThis.DB_VERSION = 4;
            indexedDB.open('CPlayer5DB', DB_VERSION);
        </script>
    `, { sourceKind: 'html' }), 3);
    assert.equal(extractDatabaseVersion(`
        <script>
            var DB_VERSION = 4;
            { let DB_VERSION = 9; globalThis.DB_VERSION = 3; }
            indexedDB.open('CPlayer5DB', DB_VERSION);
        </script>
    `, { sourceKind: 'html' }), 3);
    assert.equal(extractDatabaseVersion(`
        <script>
            function version() {}
            version = 4;
            globalThis.version = 3;
            indexedDB.open('CPlayer5DB', version);
        </script>
    `, { sourceKind: 'html' }), 3);
    assert.equal(extractDatabaseVersion(`
        <script>
            let VERSION = 3;
            class VersionOwner { static { var VERSION = 4; } }
            indexedDB.open('CPlayer5DB', VERSION);
        </script>
    `, { sourceKind: 'html' }), 3);
    for (const memberMutation of [
        '({ version: globalThis.DB_VERSION } = { version: 3 });',
        '[globalThis.DB_VERSION] = [3];',
        'for (globalThis.DB_VERSION of [3]) {}'
    ]) {
        assert.throws(() => extractDatabaseVersion(`
            <script>
                var DB_VERSION = 4;
                ${memberMutation}
                indexedDB.open('CPlayer5DB', DB_VERSION);
            </script>
        `, { sourceKind: 'html' }), /unresolved/);
    }
    assert.throws(() => extractDatabaseVersion(`
        <script>
            var DB_VERSION = 4;
            const key = getVersionKey();
            ({ version: globalThis[key] } = { version: 3 });
            indexedDB.open('CPlayer5DB', DB_VERSION);
        </script>
    `, { sourceKind: 'html' }), /unsupported/);
    assert.throws(() => extractDatabaseVersion(`
        let DB_VERSION = 4;
        function setOld() { DB_VERSION = 3; }
        function unusedReset() { DB_VERSION = 4; }
        setOld();
        indexedDB.open('CPlayer5DB', DB_VERSION);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        let DB_VERSION = 4;
        function openLater() { indexedDB.open('CPlayer5DB', DB_VERSION); }
        DB_VERSION = 3;
        openLater();
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        let DB_VERSION = 4;
        try { DB_VERSION = 3; maybeThrow(); } catch { DB_VERSION = 4; }
        indexedDB.open('CPlayer5DB', DB_VERSION);
    `), /unresolved/);
    assert.equal(extractDatabaseVersion(`
        const idb = indexedDB;
        idb.open('CPlayer5DB', 4);
    `), 4);
    assert.throws(() => extractDatabaseVersion(`
        function staleV4() { indexedDB.open('CPlayer5DB', 4); }
        const idb = indexedDB;
        idb.open('CPlayer5DB', 3);
    `), /ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        function staleV4() { indexedDB.open('CPlayer5DB', 4); }
        const idb = globalThis['indexed' + 'DB'];
        const name = 'CPlayer5' + 'DB';
        idb.open(name, 3);
    `), /ambiguous/);
    assert.equal(extractDatabaseVersion(`
        const idb = globalThis['indexed' + 'DB'];
        idb['op' + 'en']('CPlayer5' + 'DB', 3);
    `), 3);
    assert.throws(() => extractDatabaseVersion(`
        function staleV4() { indexedDB.open('CPlayer5DB', 4); }
        const root = globalThis;
        const idb = root['indexed' + 'DB'];
        function openDb(factory, name, version) { factory.open(name, version); }
        openDb(idb, 'CPlayer5DB', 3);
    `), /unresolved|ambiguous/);
    assert.throws(() => extractDatabaseVersion(`
        function staleV4() { indexedDB.open('CPlayer5DB', 4); }
        const { indexedDB: idb } = globalThis;
        function openDb(factory, name, version) { factory.open(name, version); }
        openDb(idb, 'CPlayer5DB', 3);
    `), /unresolved/);
    assert.throws(() => extractDatabaseVersion(`
        const open = indexedDB.open.bind(indexedDB);
        open('CPlayer5DB', 3);
    `), /unresolved/);
    for (const call of [
        "const idb = indexedDB; const open = idb.open; open('CPlayer5DB', 3);",
        "const idb = indexedDB; (0, idb.open)('CPlayer5DB', 3);",
        "const idb = indexedDB; idb.open.call(idb, 'CPlayer5DB', 3);",
        "const idb = indexedDB; idb.open.bind(idb)('CPlayer5DB', 3);"
    ]) {
        assert.throws(() => extractDatabaseVersion(call), /unresolved/);
    }
    assert.throws(() => extractDatabaseVersion(`
        function staleV4() { indexedDB.open('CPlayer5DB', 4); }
        for (const indexedDB of []) {}
        indexedDB.open('CPlayer5DB', 3);
    `), /ambiguous/);
    assert.equal(extractDatabaseVersion(`
        <html><!-- <script>indexedDB.open('CPlayer5DB', 9)</script> -->
        <script>const DB_NAME = 'CPlayer5DB';</script>
        <script type=" text/ecmascript ">const DB_VERSION = 3; indexedDB.open(DB_NAME, DB_VERSION);</script>
        </html>
    `, { sourceKind: 'html' }), 3);
    assert.throws(() => extractDatabaseVersion(`
        <base href="assets/"><script src="db.js"></script>
    `, {
        sourceKind: 'html',
        loadScript: () => "indexedDB.open('CPlayer5DB', 4);"
    }), /base href/);
    for (const scheduledWriter of [
        { tag: '<script async src="scheduled-db.js"></script>', body: 'globalThis.DB_VERSION = 3;' },
        { tag: '<script async src="scheduled-db.js"></script>', body: 'DB_VERSION = 3;' },
        { tag: '<script async src="scheduled-db.js"></script>', body: 'var DB_VERSION = 3;' },
        { tag: '<script async src="scheduled-db.js"></script>', body: 'for (var DB_VERSION of [3]) {}' },
        { tag: '<script async src="scheduled-db.js"></script>', body: 'for (var [DB_VERSION] of [[3]]) {}' },
        { tag: '<script async src="scheduled-db.js"></script>', body: 'for (var DB_VERSION in { old: true }) {}' },
        { tag: '<script type="module" src="scheduled-db.js"></script>', body: 'DB_VERSION = 3;' }
    ]) {
        assert.throws(() => extractDatabaseVersion(`
            <script>var DB_VERSION = 4;</script>
            ${scheduledWriter.tag}
            <script defer>indexedDB.open('CPlayer5DB', DB_VERSION)</script>
        `, {
            sourceKind: 'html',
            loadScript: () => scheduledWriter.body
        }), /unresolved/);
    }
    for (const scheduledBody of [
        'SCHEMA_VERSION = 3;',
        'globalThis.SCHEMA_VERSION = 3;'
    ]) {
        assert.throws(() => extractDatabaseVersion(`
            <script>var SCHEMA_VERSION = 4;</script>
            <script async src="scheduled-schema.js"></script>
            <script defer>
                const version = SCHEMA_VERSION;
                indexedDB.open('CPlayer5DB', version);
            </script>
        `, {
            sourceKind: 'html',
            loadScript: () => scheduledBody
        }), /unresolved/);
    }
    assert.throws(() => extractDatabaseVersion(`
        <script>
            var DB_NAME = 'OtherDB';
            var OLD_VERSION = 3;
            indexedDB.open('CPlayer5DB', 4);
        </script>
        <script async src="scheduled-name.js"></script>
        <script defer>indexedDB.open(DB_NAME, OLD_VERSION);</script>
    `, {
        sourceKind: 'html',
        loadScript: () => "globalThis.DB_NAME = 'CPlayer5DB';"
    }), /unresolved|ambiguous/);
});

test('rollback version extraction rejects runtime-generated code', () => {
    const staleV4 = "indexedDB.open('CPlayer5DB', 4);";
    for (const dynamicSource of [
        `${staleV4} eval("indexedDB.open('CPlayer5DB', 3)");`,
        `${staleV4} Function("indexedDB.open('CPlayer5DB', 3)")();`,
        `${staleV4} setTimeout("indexedDB.open('CPlayer5DB', 3)", 0);`,
        `${staleV4} document.write("<script>indexedDB.open('CPlayer5DB', 3)<\\/script>");`,
        `${staleV4} const { Function: F } = globalThis; F("indexedDB.open('CPlayer5DB', 3)")();`,
        `${staleV4} const { eval: indirectEval } = globalThis; indirectEval("indexedDB.open('CPlayer5DB', 3)");`,
        `${staleV4} const { setTimeout: timer } = globalThis; timer("indexedDB.open('CPlayer5DB', 3)", 0);`,
        `${staleV4} const { write } = document; write("<script>indexedDB.open('CPlayer5DB', 3)<\\/script>");`,
        `${staleV4} const { document: { write } } = globalThis; write.call(document, "<script>indexedDB.open('CPlayer5DB', 3)<\\/script>");`,
        `${staleV4} let code = "indexedDB.open('CPlayer5DB', 3)"; setTimeout(code, 0);`,
        `${staleV4} function schedule(code) { setTimeout(code, 0); }`,
        `import { Promise } from './promise-shim.mjs'; ${staleV4} new Promise((code) => setTimeout(code, 0));`,
        `${staleV4} importScripts('https://example.invalid/old-db.js');`,
        `${staleV4} window.open("javascript:indexedDB.open('CPlayer5DB', 3)");`,
        `${staleV4} location.assign("javascript:indexedDB.open('CPlayer5DB', 3)");`,
        `${staleV4} location.href = "javascript:indexedDB.open('CPlayer5DB', 3)";`,
        `${staleV4} Reflect.get(globalThis, 'eval')("indexedDB.open('CPlayer5DB', 3)");`,
        `${staleV4} (() => {}).constructor("indexedDB.open('CPlayer5DB', 3)")();`,
        `${staleV4} Reflect.set(globalThis, 'DB_VERSION', 3);`,
        `${staleV4} Object.assign(globalThis, { DB_VERSION: 3 });`,
        `${staleV4} Object.defineProperty(globalThis, 'DB_VERSION', { value: 3 });`,
        `${staleV4} Reflect.defineProperty(globalThis, 'DB_VERSION', { value: 3 });`,
        `${staleV4} import('https://example.invalid/old-db.mjs');`,
        `import 'https://example.invalid/old-db.mjs'; ${staleV4}`
    ]) {
        assert.throws(() => extractDatabaseVersion(dynamicSource), /unsupported/);
    }
    assert.equal(extractDatabaseVersion(`
        import './db.mjs';
        function runLater() {}
        setTimeout(runLater, 0);
        new Promise((resolve, reject) => {
            setTimeout(resolve, 1);
            setTimeout(reject, 1);
        });
        indexedDB.open('CPlayer5DB', 4);
    `), 4);
});

test('rollback target combines deployed and residual runtime database versions', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'cplayer-rollback-ref-'));
    try {
        runGit(sandbox, ['init', '--quiet']);
        runGit(sandbox, ['config', 'user.email', 'tests@cplayer.invalid']);
        runGit(sandbox, ['config', 'user.name', 'CPlayer Tests']);
        await mkdir(resolve(sandbox, 'js'));
        await mkdir(resolve(sandbox, 'img'));
        await writeFile(
            resolve(sandbox, 'index.html'),
            "<script>indexedDB.open('CPlayer5DB', 3)</script>\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'js', 'app.js'),
            "indexedDB.open('CPlayer5DB', 4);\n",
            'utf8'
        );
        runGit(sandbox, ['add', 'index.html', 'js/app.js']);
        runGit(sandbox, ['commit', '--quiet', '-m', 'conflicting runtime']);
        assert.throws(() => readTargetDatabaseVersion('HEAD', sandbox), /ambiguous/);

        await writeFile(
            resolve(sandbox, 'index.html'),
            '<script type="module" src="./js/app.js"></script>\n',
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'js', 'app.js'),
            "import './db.mjs'; import '../img/db.mjs'; indexedDB.open('CPlayer5DB', 4);\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'js', 'db.mjs'),
            "indexedDB.open('CPlayer5DB', 3);\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'playlist-downloader.html'),
            "<script>indexedDB.open('CPlayer5DB', 3)</script>\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'img', 'db.mjs'),
            "indexedDB.open('CPlayer5DB', 3);\n",
            'utf8'
        );
        runGit(sandbox, ['add', 'index.html', 'js/app.js', 'js/db.mjs', 'img/db.mjs']);
        runGit(sandbox, ['add', 'playlist-downloader.html']);
        runGit(sandbox, ['commit', '--quiet', '-m', 'conflicting module']);
        assert.throws(() => readTargetDatabaseVersion('HEAD', sandbox), /ambiguous/);

        await writeFile(
            resolve(sandbox, 'js', 'db.mjs'),
            "indexedDB.open('CPlayer5DB', 4);\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'playlist-downloader.html'),
            "<script>indexedDB.open('CPlayer5DB', 4)</script>\n",
            'utf8'
        );
        runGit(sandbox, ['add', 'js/db.mjs', 'playlist-downloader.html']);
        runGit(sandbox, ['commit', '--quiet', '-m', 'conflicting deployed directory module']);
        assert.throws(() => readTargetDatabaseVersion('HEAD', sandbox), /ambiguous/);

        await writeFile(
            resolve(sandbox, 'img', 'db.mjs'),
            "indexedDB.open('CPlayer5DB', 4);\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'img', 'legacy.html'),
            "<script>indexedDB.open('CPlayer5DB', 3)</script>\n",
            'utf8'
        );
        runGit(sandbox, ['add', 'img/db.mjs', 'img/legacy.html']);
        runGit(sandbox, ['commit', '--quiet', '-m', 'conflicting deployed directory html']);
        assert.throws(() => readTargetDatabaseVersion('HEAD', sandbox), /ambiguous/);

        await writeFile(
            resolve(sandbox, 'img', 'legacy.html'),
            '<script src="./legacy-db.js"></script>\n',
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'img', 'legacy-db.js'),
            "indexedDB.open('CPlayer5DB', 3);\n",
            'utf8'
        );
        runGit(sandbox, ['add', 'img/legacy.html', 'img/legacy-db.js']);
        runGit(sandbox, ['commit', '--quiet', '-m', 'conflicting nested html script']);
        assert.throws(() => readTargetDatabaseVersion('HEAD', sandbox), /ambiguous/);

        await writeFile(
            resolve(sandbox, 'img', 'legacy-db.js'),
            "indexedDB.open('CPlayer5DB', 4);\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'img', 'classic-worker.js'),
            "var DB_VERSION = 4; globalThis.DB_VERSION = 3; indexedDB.open('CPlayer5DB', DB_VERSION);\n",
            'utf8'
        );
        runGit(sandbox, ['add', 'img/legacy-db.js', 'img/classic-worker.js']);
        runGit(sandbox, ['commit', '--quiet', '-m', 'ambiguous standalone script mode']);
        assert.throws(() => readTargetDatabaseVersion('HEAD', sandbox), /ambiguous/);
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});

test('current rollback floor includes residual JavaScript modules', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'cplayer-rollback-current-'));
    try {
        await mkdir(resolve(sandbox, 'js'));
        await mkdir(resolve(sandbox, 'img'));
        await writeFile(
            resolve(sandbox, 'index.html'),
            '<script type="module" src="./js/app.js"></script>\n',
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'js', 'app.js'),
            "indexedDB.open('CPlayer5DB', 4);\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'js', 'db.mjs'),
            "indexedDB.open('CPlayer5DB', 5);\n",
            'utf8'
        );

        assert.throws(() => readCurrentDatabaseVersion(sandbox), /ambiguous/);

        await writeFile(
            resolve(sandbox, 'js', 'db.mjs'),
            "indexedDB.open('CPlayer5DB', 4);\n",
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'img', 'legacy.html'),
            '<script src="./legacy-db.js"></script>\n',
            'utf8'
        );
        await writeFile(
            resolve(sandbox, 'img', 'legacy-db.js'),
            "indexedDB.open('CPlayer5DB', 5);\n",
            'utf8'
        );

        assert.throws(() => readCurrentDatabaseVersion(sandbox), /ambiguous/);
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});

test('rollback guard rejects a schema downgrade and accepts the current floor', () => {
    assert.deepEqual(assertRollbackVersion(6, 6), { currentVersion: 6, targetVersion: 6 });
    assert.deepEqual(assertRollbackVersion(6, 7), { currentVersion: 6, targetVersion: 7 });
    assert.throws(() => assertRollbackVersion(6, 5), /Unsafe rollback/);
    assert.throws(() => assertRollbackVersion(6, null), /could not be determined/);
});

test('rollback guard trusts only the exact pinned Supabase browser bundle', async () => {
    const source = await readFile(resolve('js', 'vendor', 'supabase.js'), 'utf8');
    assert.equal(isTrustedDynamicRuntimeSource('js/vendor/supabase.js', source), true);
    assert.equal(isTrustedDynamicRuntimeSource('js/vendor/other.js', source), false);
    assert.equal(isTrustedDynamicRuntimeSource('js/vendor/supabase.js', source + '\n'), false);
});

test('repository inspection enforces UTF-8 text and skips known binary assets only', () => {
    assert.deepEqual(inspectRepositoryFile('notes.md', Buffer.from('ok\n')), {
        skippedBinary: false,
        failures: []
    });
    assert.match(inspectRepositoryFile('notes.md', Buffer.from('bad\n\n')).failures[0], /extra blank line/);
    assert.match(inspectRepositoryFile('script.js', Buffer.from([0xff, 0xfe, 0x61, 0x00])).failures[0], /NUL bytes|valid UTF-8/);
    assert.match(inspectRepositoryFile('bom.js', Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b])).failures[0], /BOM/);
    assert.match(inspectRepositoryFile('legacy.md', Buffer.from('bad   \rnext\r')).failures[0], /trailing whitespace/);
    assert.equal(inspectRepositoryFile('cover.png', Buffer.from([0x00, 0xff])).skippedBinary, true);
});

test('repository check skips large staged binary snapshots without buffering the blob', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'cplayer-large-binary-check-'));
    try {
        runGit(sandbox, ['init', '--quiet']);
        await writeFile(resolve(sandbox, 'font.woff2'), Buffer.alloc(2 * 1024 * 1024, 0x41));
        runGit(sandbox, ['add', 'font.woff2']);

        const result = await checkRepositoryState(sandbox);
        assert.equal(result.skippedBinaryFiles, 1);
        assert.equal(result.checkedTextFiles, 0);
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});

test('repository check rejects a staged non-UTF-8 source file', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'cplayer-repo-check-'));
    try {
        runGit(sandbox, ['init', '--quiet']);
        await writeFile(resolve(sandbox, 'staged.js'), Buffer.from([0xff, 0xfe, 0x61, 0x00]));
        runGit(sandbox, ['add', 'staged.js']);
        await assert.rejects(checkRepositoryState(sandbox), /staged\.js \(staged\).*(NUL bytes|valid UTF-8)/);
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});

test('repository check scans the staged blob for a file type change', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'cplayer-repo-type-'));
    try {
        runGit(sandbox, ['init', '--quiet']);
        runGit(sandbox, ['config', 'user.email', 'tests@cplayer.invalid']);
        runGit(sandbox, ['config', 'user.name', 'CPlayer Tests']);
        await writeFile(resolve(sandbox, 'source.js'), 'const ok = true;\n', 'utf8');
        runGit(sandbox, ['add', 'source.js']);
        runGit(sandbox, ['commit', '--quiet', '-m', 'base']);

        const blob = runGit(sandbox, ['hash-object', '-w', '--stdin'], {
            input: Buffer.from([0xff, 0xfe, 0x61, 0x00])
        }).stdout.trim();
        runGit(sandbox, ['update-index', '--cacheinfo', `120000,${blob},source.js`]);

        await assert.rejects(checkRepositoryState(sandbox), /source\.js \(staged\).*(NUL bytes|valid UTF-8)/);
    } finally {
        await rm(sandbox, { recursive: true, force: true });
    }
});
