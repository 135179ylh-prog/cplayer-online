import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    readCurrentDatabaseVersion,
    readTargetDatabaseVersion
} from '../scripts/check-rollback-target.mjs';

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
    assert.deepEqual(assertRollbackVersion(5, 5), { currentVersion: 5, targetVersion: 5 });
    assert.deepEqual(assertRollbackVersion(5, 6), { currentVersion: 5, targetVersion: 6 });
    assert.throws(() => assertRollbackVersion(5, 4), /Unsafe rollback/);
    assert.throws(() => assertRollbackVersion(5, null), /could not be determined/);
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
