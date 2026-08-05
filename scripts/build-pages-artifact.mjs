import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CORE_ASSETS,
    assertServiceWorkerContract,
    computePrecacheRevision
} from './pages-contract.mjs';

export const PAGE_FILES = Object.freeze([
    'index.html',
    'manifest.json',
    'playlist.js',
    'playlist-downloader.html',
    'sw.js'
]);

export const PAGE_DIRECTORIES = Object.freeze([
    'css',
    'fonts',
    'img',
    'js',
    'webfonts'
]);

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PAGES_OUTPUT_DIRECTORY = resolve(PROJECT_ROOT, 'output', 'pages');
export const BUILD_METADATA_FILENAME = 'build-meta.json';

function comparablePath(path) {
    const normalized = resolve(path);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function assertSafeOutputDirectory(outputDirectory, projectRoot = PROJECT_ROOT) {
    const candidate = resolve(outputDirectory);
    const expected = resolve(projectRoot, 'output', 'pages');
    const pathFromOutput = relative(resolve(projectRoot, 'output'), candidate);
    if (comparablePath(candidate) !== comparablePath(expected) || isAbsolute(pathFromOutput)) {
        throw new Error(`Refusing to replace unsafe Pages output directory: ${candidate}`);
    }
    return candidate;
}

async function assertPhysicalOutputBoundary(projectRoot, outputDirectory) {
    const outputRoot = resolve(projectRoot, 'output');
    await mkdir(outputRoot, { recursive: true });

    const outputRootInfo = await lstat(outputRoot);
    if (outputRootInfo.isSymbolicLink()) {
        throw new Error(`Refusing linked Pages output root: ${outputRoot}`);
    }

    const realProjectRoot = await realpath(projectRoot);
    const realOutputRoot = await realpath(outputRoot);
    if (comparablePath(realOutputRoot) !== comparablePath(resolve(realProjectRoot, 'output'))) {
        throw new Error(`Pages output root resolves outside the project: ${realOutputRoot}`);
    }

    try {
        const outputInfo = await lstat(outputDirectory);
        if (outputInfo.isSymbolicLink()) {
            throw new Error(`Refusing linked Pages output directory: ${outputDirectory}`);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function listArtifactFiles(root, directory = root) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const absolutePath = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) {
            throw new Error(`Pages artifact cannot contain a symbolic link: ${relative(root, absolutePath)}`);
        }
        if (entry.isDirectory()) {
            files.push(...await listArtifactFiles(root, absolutePath));
        } else if (entry.isFile()) {
            files.push(relative(root, absolutePath).split(sep).join('/'));
        }
    }
    return files.sort();
}

function readBuildCommit(projectRoot) {
    const workflowCommit = String(process.env.GITHUB_SHA || '').trim();
    if (/^[0-9a-f]{40}$/i.test(workflowCommit)) return workflowCommit.toLowerCase();
    try {
        const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: projectRoot,
            encoding: 'utf8'
        }).trim();
        if (/^[0-9a-f]{40}$/i.test(localCommit)) return localCommit.toLowerCase();
    } catch (error) {
        // A copied source tree without Git metadata can still be inspected locally.
    }
    return 'unknown';
}

async function readPagesContract(projectRoot) {
    const serviceWorkerSource = await readFile(resolve(projectRoot, 'sw.js'), 'utf8');
    const precacheRevision = await computePrecacheRevision(projectRoot);
    const serviceWorker = assertServiceWorkerContract(serviceWorkerSource, precacheRevision);
    return {
        cacheName: serviceWorker.cacheName,
        precacheRevision,
        precacheAssets: [...CORE_ASSETS]
    };
}

export async function buildPagesArtifact(options = {}) {
    const projectRoot = resolve(options.projectRoot || PROJECT_ROOT);
    const outputDirectory = assertSafeOutputDirectory(
        options.outputDirectory || resolve(projectRoot, 'output', 'pages'),
        projectRoot
    );

    await assertPhysicalOutputBoundary(projectRoot, outputDirectory);
    const contract = await readPagesContract(projectRoot);
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });

    for (const source of PAGE_FILES) {
        await cp(resolve(projectRoot, source), resolve(outputDirectory, source));
    }
    for (const source of PAGE_DIRECTORIES) {
        await cp(resolve(projectRoot, source), resolve(outputDirectory, source), {
            recursive: true
        });
    }

    const buildMetadata = {
        schema: 1,
        commit: readBuildCommit(projectRoot),
        cacheName: contract.cacheName,
        precacheRevision: contract.precacheRevision,
        precacheAssets: contract.precacheAssets,
        generatedAt: new Date().toISOString()
    };
    await writeFile(
        resolve(outputDirectory, BUILD_METADATA_FILENAME),
        `${JSON.stringify(buildMetadata, null, 2)}\n`,
        'utf8'
    );

    const files = await listArtifactFiles(outputDirectory);
    const bytes = (await Promise.all(files.map(async (file) => {
        return (await stat(resolve(outputDirectory, file))).size;
    }))).reduce((total, size) => total + size, 0);

    return {
        outputDirectory,
        files,
        bytes,
        commit: buildMetadata.commit,
        cacheName: contract.cacheName,
        precacheRevision: contract.precacheRevision
    };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    const result = await buildPagesArtifact();
    console.log(`Pages artifact: ${result.outputDirectory}`);
    console.log(`Pages files: ${result.files.length}`);
    console.log(`Pages bytes: ${result.bytes}`);
}
