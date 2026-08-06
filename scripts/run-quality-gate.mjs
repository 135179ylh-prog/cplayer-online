import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const stateDirectory = resolve(root, 'output', 'quality-gate');
const statePath = resolve(stateDirectory, 'state.json');
const STATE_SCHEMA = 1;

const generatedCss = resolve(root, 'css', 'tailwind.css');
const cloudVendor = resolve(root, 'js', 'vendor', 'supabase.js');

function readSnapshot(path) {
    return existsSync(path) ? readFileSync(path) : null;
}

function assertGeneratedFileUnchanged(path, before, name) {
    const after = readSnapshot(path);
    if (!before || !after || !before.equals(after)) {
        return [
            `${name} was stale and has been rebuilt.`,
            'Review and commit the generated file, then run npm run verify again.'
        ].join('\n');
    }
    return null;
}

// Each layer is a named step so a step can be listed, selected, resumed, and
// reported on its own. Splitting the gate this way keeps every layer in the
// default run while letting an interrupted long layer be retried alone.
export const STEPS = Object.freeze([
    { id: 'build-css', label: 'Build committed CSS', args: ['run', 'build:css'], guard: 'css' },
    { id: 'build-cloud-vendor', label: 'Build vendored cloud SDK', args: ['run', 'build:cloud-vendor'], guard: 'cloud-vendor' },
    { id: 'test-unit', label: 'Unit tests', args: ['run', 'test:unit'] },
    { id: 'check-module', label: 'Main module syntax', args: ['run', 'check:module'] },
    { id: 'check-sw', label: 'Service Worker syntax', args: ['run', 'check:sw'] },
    { id: 'check-features', label: 'Static feature contracts', args: ['run', 'check:features'] },
    { id: 'audit', label: 'Dependency audit', args: ['audit', '--audit-level=high'] },
    { id: 'build-pages', label: 'Build GitHub Pages artifact', args: ['run', 'build:pages'] },
    { id: 'test-e2e', label: 'Browser regression from Pages artifact', args: ['run', 'test:e2e'], pagesRoot: true },
    { id: 'check-repo', label: 'Repository whitespace and untracked text', args: ['run', 'check:repo'] }
]);

export function parseGateArgs(argv) {
    const options = { mode: 'run', only: [], from: '', resume: false, unknown: [] };
    for (const argument of argv) {
        const [flag, inlineValue] = argument.includes('=')
            ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
            : [argument, ''];
        if (flag === '--list') options.mode = 'list';
        else if (flag === '--status') options.mode = 'status';
        else if (flag === '--resume') options.resume = true;
        else if (flag === '--only') options.only.push(...inlineValue.split(',').filter(Boolean));
        else if (flag === '--from') options.from = inlineValue;
        else options.unknown.push(argument);
    }
    return options;
}

export function selectSteps(steps, options) {
    if (options.only.length) {
        const known = new Set(steps.map((step) => step.id));
        const missing = options.only.filter((id) => !known.has(id));
        if (missing.length) throw new Error(`Unknown quality gate step: ${missing.join(', ')}`);
        return steps.filter((step) => options.only.includes(step.id));
    }
    if (options.from) {
        const index = steps.findIndex((step) => step.id === options.from);
        if (index < 0) throw new Error(`Unknown quality gate step: ${options.from}`);
        return steps.slice(index);
    }
    return [...steps];
}

function isProcessAlive(pid) {
    if (!pid || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// A step left as running belongs to a run that never finished. Reporting that
// as a failure is exactly the misjudgement this state file prevents, so it is
// reclassified as interrupted once its owning process is gone.
export function expireInterruptedSteps(state, isAlive = isProcessAlive) {
    let expired = 0;
    for (const record of Object.values(state.steps || {})) {
        if (record.status !== 'running') continue;
        if (isAlive(record.pid)) continue;
        record.status = 'interrupted';
        record.finishedAt = record.finishedAt || new Date().toISOString();
        expired += 1;
    }
    return expired;
}

function emptyState() {
    return { schema: STATE_SCHEMA, startedAt: null, updatedAt: null, steps: {} };
}

export function loadState(path = statePath) {
    if (!existsSync(path)) return emptyState();
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed?.schema !== STATE_SCHEMA || typeof parsed.steps !== 'object' || !parsed.steps) {
            return emptyState();
        }
        return parsed;
    } catch (error) {
        return emptyState();
    }
}

// A fresh full run must not inherit records written by an older revision of the
// step list, otherwise --status would mix two runs into one report.
export function prepareRunState(state, options, selected, steps = STEPS) {
    if (options.resume) return state;
    if (selected.length !== steps.length) return state;
    const fresh = emptyState();
    fresh.startedAt = new Date().toISOString();
    return fresh;
}

function saveState(state) {
    state.updatedAt = new Date().toISOString();
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function formatStateReport(state, steps = STEPS) {
    const lines = [];
    for (const [index, step] of steps.entries()) {
        const record = state.steps?.[step.id];
        const position = `${String(index + 1).padStart(2, '0')}/${steps.length}`;
        if (!record) {
            lines.push(`${position} ${step.id.padEnd(20)} not run`);
            continue;
        }
        const seconds = record.durationMs ? ` ${(record.durationMs / 1000).toFixed(1)}s` : '';
        const exit = Number.isInteger(record.exitCode) ? ` exit=${record.exitCode}` : '';
        lines.push(`${position} ${step.id.padEnd(20)} ${record.status}${seconds}${exit}`);
    }
    return lines.join('\n');
}

// Prefer running npm's own CLI through this Node binary. Spawning `npm` with a
// shell on Windows would need shell escaping (DEP0190) and would depend on PATH.
export function resolveNpmCommand(env = process.env, execPath = process.execPath) {
    if (env.npm_execpath) return { command: execPath, prefixArgs: [env.npm_execpath], shell: false };
    const bundled = resolve(execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(bundled)) return { command: execPath, prefixArgs: [bundled], shell: false };
    return { command: 'npm', prefixArgs: [], shell: process.platform === 'win32' };
}

function runStep(step, position, total, logPath) {
    process.stdout.write(`\n=== ${position}/${total} ${step.label} (${step.id}) ===\n`);
    const env = step.pagesRoot
        ? { ...process.env, PW_WEB_ROOT: resolve(root, 'output', 'pages') }
        : process.env;
    const npm = resolveNpmCommand();
    const log = createWriteStream(logPath);
    const child = spawn(npm.command, [...npm.prefixArgs, ...step.args], {
        cwd: root,
        env,
        shell: npm.shell,
        stdio: ['inherit', 'pipe', 'pipe']
    });

    // Tee live output so an outer timeout still leaves the layer's own log on
    // disk instead of only a killed parent process.
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    return new Promise((resolveRun) => {
        let settled = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            log.end();
            resolveRun(result);
        };
        child.on('error', (error) => settle({ status: 'failed', exitCode: 1, message: `could not start: ${error.message}` }));
        child.on('close', (code, signal) => {
            if (signal) {
                settle({ status: 'interrupted', exitCode: null, message: `terminated by signal ${signal}` });
                return;
            }
            settle(code === 0
                ? { status: 'passed', exitCode: 0 }
                : { status: 'failed', exitCode: code ?? 1, message: `failed with exit code ${code}` });
        });
    });
}

async function main(argv) {
    const options = parseGateArgs(argv);
    if (options.unknown.length) {
        console.error(`Unknown quality gate option: ${options.unknown.join(' ')}`);
        console.error('Usage: node scripts/run-quality-gate.mjs [--list] [--status] [--resume] [--only=<id,...>] [--from=<id>]');
        process.exit(2);
    }

    if (options.mode === 'list') {
        for (const [index, step] of STEPS.entries()) {
            process.stdout.write(`${String(index + 1).padStart(2, '0')}/${STEPS.length} ${step.id.padEnd(20)} ${step.label}\n`);
        }
        return;
    }

    const state = loadState();
    const expired = expireInterruptedSteps(state);

    if (options.mode === 'status') {
        if (expired) saveState(state);
        process.stdout.write(`${formatStateReport(state)}\n`);
        if (expired) {
            process.stdout.write(`\n${expired} step(s) were interrupted by an outer timeout, not by a test failure.\n`);
            process.stdout.write('Continue with: npm run verify:resume\n');
        }
        return;
    }

    let selected;
    try {
        selected = selectSteps(STEPS, options);
    } catch (error) {
        console.error(error.message);
        process.exit(2);
    }

    const runState = prepareRunState(state, options, selected);

    if (options.resume) {
        const done = selected.filter((step) => runState.steps[step.id]?.status === 'passed');
        selected = selected.filter((step) => runState.steps[step.id]?.status !== 'passed');
        if (done.length) {
            process.stdout.write(`Resuming: ${done.length} step(s) already passed, ${selected.length} remaining.\n`);
        }
        if (!selected.length) {
            process.stdout.write(`${formatStateReport(runState)}\n\nQuality gate already complete for every selected step.\n`);
            return;
        }
    }

    runState.startedAt = runState.startedAt || new Date().toISOString();
    mkdirSync(stateDirectory, { recursive: true });

    const guards = new Map([
        ['css', { path: generatedCss, name: 'Generated css/tailwind.css' }],
        ['cloud-vendor', { path: cloudVendor, name: 'js/vendor/supabase.js' }]
    ]);

    for (const [index, step] of selected.entries()) {
        const position = index + 1;
        const absoluteIndex = STEPS.findIndex((candidate) => candidate.id === step.id) + 1;
        const logPath = resolve(stateDirectory, `${String(absoluteIndex).padStart(2, '0')}-${step.id}.log`);
        const guard = step.guard ? guards.get(step.guard) : null;
        const before = guard ? readSnapshot(guard.path) : null;

        runState.steps[step.id] = {
            index: absoluteIndex,
            label: step.label,
            status: 'running',
            pid: process.pid,
            exitCode: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            durationMs: null,
            log: `output/quality-gate/${String(absoluteIndex).padStart(2, '0')}-${step.id}.log`
        };
        saveState(runState);

        const startedAtMs = Date.now();
        let result = await runStep(step, position, selected.length, logPath);
        if (result.status === 'passed' && guard) {
            const staleMessage = assertGeneratedFileUnchanged(guard.path, before, guard.name);
            if (staleMessage) result = { status: 'failed', exitCode: 1, message: staleMessage };
        }

        const record = runState.steps[step.id];
        record.status = result.status;
        record.exitCode = result.exitCode;
        record.finishedAt = new Date().toISOString();
        record.durationMs = Date.now() - startedAtMs;
        if (result.message) record.message = result.message;
        saveState(runState);

        if (result.status !== 'passed') {
            console.error(`\n${step.label} (${step.id}) ${result.message || result.status}.`);
            console.error(`Layer log: ${record.log}`);
            console.error('Review the log, then continue with: npm run verify:resume');
            process.exit(result.exitCode || 1);
        }
    }

    process.stdout.write(`\n${formatStateReport(runState)}\n`);
    const allPassed = STEPS.every((step) => runState.steps[step.id]?.status === 'passed');
    process.stdout.write(allPassed
        ? '\nQuality gate passed.\n'
        : '\nSelected quality gate steps passed. Run npm run verify for the full gate.\n');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    await main(process.argv.slice(2));
}
