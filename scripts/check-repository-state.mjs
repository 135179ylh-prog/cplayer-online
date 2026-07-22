import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BINARY_EXTENSIONS = new Set([
    '.aac', '.flac', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.m4a', '.mp3',
    '.mp4', '.otf', '.pdf', '.png', '.ttf', '.wasm', '.wav', '.webp', '.woff',
    '.woff2', '.zip'
]);

export function inspectRepositoryFile(file, bytes) {
    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) {
        return { skippedBinary: true, failures: [] };
    }
    if (bytes.includes(0)) {
        return { skippedBinary: false, failures: [`${file}: text file contains NUL bytes; UTF-8 is required`] };
    }

    const failures = [];
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        failures.push(`${file}: UTF-8 BOM is not allowed`);
    }

    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
        return { skippedBinary: false, failures: [`${file}: text file is not valid UTF-8`] };
    }

    const normalizedText = text.replace(/\r\n?/g, '\n');
    const lines = normalizedText.split('\n');
    lines.forEach((line, index) => {
        if (/[\t ]+$/.test(line)) failures.push(`${file}:${index + 1}: trailing whitespace`);
    });
    if (/\n\n+$/.test(normalizedText)) failures.push(`${file}: extra blank line at EOF`);
    return { skippedBinary: false, failures };
}
function runGit(args, options = {}) {
    const result = spawnSync('git', args, {
        cwd: options.root || ROOT,
        encoding: options.encoding === null ? null : 'utf8',
        stdio: 'pipe'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const stdout = result.stdout?.toString().trim();
        const stderr = result.stderr?.toString().trim();
        throw new Error(stdout || stderr || `git ${args[0]} failed with exit code ${result.status}`);
    }
    return result.stdout || (options.encoding === null ? Buffer.alloc(0) : '');
}

function parseNullSeparatedPaths(value) {
    return value.split('\0').filter(Boolean);
}

export async function checkRepositoryState(root = ROOT) {
    runGit(['diff', '--check'], { root });
    runGit(['diff', '--cached', '--check'], { root });

    const staged = parseNullSeparatedPaths(runGit([
        'diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'
    ], { root }));
    const unstaged = parseNullSeparatedPaths(runGit([
        'diff', '--name-only', '--diff-filter=ACMRT', '-z'
    ], { root }));
    const untracked = parseNullSeparatedPaths(runGit([
        'ls-files', '--others', '--exclude-standard', '-z'
    ], { root }));
    const worktreeFiles = [...new Set([...unstaged, ...untracked])];
    const failures = [];
    let checkedTextFiles = 0;
    let skippedBinaryFiles = 0;

    const inspect = (file, bytes) => {
        const result = inspectRepositoryFile(file, bytes);
        if (result.skippedBinary) skippedBinaryFiles += 1;
        else checkedTextFiles += 1;
        failures.push(...result.failures);
    };

    for (const file of staged) {
        inspect(`${file} (staged)`, runGit(['show', `:${file}`], { root, encoding: null }));
    }
    for (const file of worktreeFiles) {
        inspect(file, await readFile(resolve(root, file)));
    }

    if (failures.length) throw new Error(failures.join('\n'));
    return {
        staged: staged.length,
        worktree: worktreeFiles.length,
        untracked: untracked.length,
        checkedTextFiles,
        skippedBinaryFiles
    };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const result = await checkRepositoryState();
        console.log(
            `repository checks: passed (${result.staged} staged and ${result.worktree} worktree paths inspected; ` +
            `${result.checkedTextFiles} text snapshots checked, ` +
            `${result.skippedBinaryFiles} known binary files skipped)`
        );
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
