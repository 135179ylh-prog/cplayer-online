import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function run(command, args, label, options = {}) {
    process.stdout.write(`\n=== ${label} ===\n`);
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        shell: options.shell === true
    });
    if (result.error) {
        console.error(`${label} could not start:`, result.error.message);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`${label} failed with exit code ${result.status}.`);
        process.exit(result.status || 1);
    }
}

function runNpm(args, label) {
    if (process.env.npm_execpath) {
        run(process.execPath, [process.env.npm_execpath, ...args], label);
        return;
    }
    run('npm', args, label, { shell: process.platform === 'win32' });
}

const generatedCss = resolve(root, 'css', 'tailwind.css');
const cssBefore = existsSync(generatedCss) ? readFileSync(generatedCss) : null;

runNpm(['run', 'build:css'], '1/8 Build committed CSS');

const cssAfter = existsSync(generatedCss) ? readFileSync(generatedCss) : null;
if (!cssBefore || !cssAfter || !cssBefore.equals(cssAfter)) {
    console.error('\nGenerated css/tailwind.css was stale and has been rebuilt.');
    console.error('Review and commit the generated file, then run npm run verify again.');
    process.exit(1);
}

runNpm(['run', 'test:unit'], '2/8 Unit tests');
runNpm(['run', 'check:module'], '3/8 Main module syntax');
runNpm(['run', 'check:sw'], '4/8 Service Worker syntax');
runNpm(['run', 'check:features'], '5/8 Static feature contracts');
runNpm(['audit', '--audit-level=high'], '6/8 Dependency audit');
runNpm(['run', 'test:e2e'], '7/8 Browser regression');
run('git', ['diff', '--check'], '8/8 Git whitespace check');

process.stdout.write('\nQuality gate passed.\n');
