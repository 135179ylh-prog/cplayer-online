import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function run(command, args, label, options = {}) {
    process.stdout.write(`\n=== ${label} ===\n`);
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        env: options.env || process.env,
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

function runNpm(args, label, options = {}) {
    if (process.env.npm_execpath) {
        run(process.execPath, [process.env.npm_execpath, ...args], label, options);
        return;
    }
    run('npm', args, label, { ...options, shell: process.platform === 'win32' });
}

const generatedCss = resolve(root, 'css', 'tailwind.css');
const cssBefore = existsSync(generatedCss) ? readFileSync(generatedCss) : null;
const cloudVendor = resolve(root, 'js', 'vendor', 'supabase.js');
const cloudVendorBefore = existsSync(cloudVendor) ? readFileSync(cloudVendor) : null;

runNpm(['run', 'build:css'], '1/10 Build committed CSS');

const cssAfter = existsSync(generatedCss) ? readFileSync(generatedCss) : null;
if (!cssBefore || !cssAfter || !cssBefore.equals(cssAfter)) {
    console.error('\nGenerated css/tailwind.css was stale and has been rebuilt.');
    console.error('Review and commit the generated file, then run npm run verify again.');
    process.exit(1);
}

runNpm(['run', 'build:cloud-vendor'], '2/10 Build vendored cloud SDK');
const cloudVendorAfter = existsSync(cloudVendor) ? readFileSync(cloudVendor) : null;
if (!cloudVendorBefore || !cloudVendorAfter || !cloudVendorBefore.equals(cloudVendorAfter)) {
    console.error('\njs/vendor/supabase.js was stale and has been rebuilt.');
    console.error('Review and commit the generated file, then run npm run verify again.');
    process.exit(1);
}

runNpm(['run', 'test:unit'], '3/10 Unit tests');
runNpm(['run', 'check:module'], '4/10 Main module syntax');
runNpm(['run', 'check:sw'], '5/10 Service Worker syntax');
runNpm(['run', 'check:features'], '6/10 Static feature contracts');
runNpm(['audit', '--audit-level=high'], '7/10 Dependency audit');
runNpm(['run', 'build:pages'], '8/10 Build GitHub Pages artifact');
runNpm(['run', 'test:e2e'], '9/10 Browser regression from Pages artifact', {
    env: { ...process.env, PW_WEB_ROOT: resolve(root, 'output', 'pages') }
});
runNpm(['run', 'check:repo'], '10/10 Repository whitespace and untracked text');

process.stdout.write('\nQuality gate passed.\n');
