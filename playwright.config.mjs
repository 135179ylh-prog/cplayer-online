import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PW_PORT || 4173);
const baseURL = `http://127.0.0.1:${port}`;
const webRoot = process.env.PW_WEB_ROOT || process.cwd();

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    // No retries on purpose: a retry can hide a real defect by letting a genuinely
    // broken test pass on a second attempt. The per-test budget is generous instead.
    // The suite runs single-worker and serial, so the heaviest cold-start specs
    // (configure cloud, seed IndexedDB, sign in, then navigate) drift well past a
    // 30s budget late in a 12-minute run even though they need under 12s in
    // isolation. That drift produced timeout failures that no assertion caused.
    retries: 0,
    workers: 1,
    timeout: 90_000,
    expect: { timeout: 7_500 },
    reporter: [
        ['list'],
        ['html', { outputFolder: 'output/playwright/report', open: 'never' }]
    ],
    outputDir: 'output/playwright/test-results',
    use: {
        baseURL,
        serviceWorkers: 'allow',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
    },
    webServer: {
        command: `node tests/e2e/server.mjs ${port}`,
        url: `${baseURL}/index.html`,
        reuseExistingServer: false,
        env: { PW_WEB_ROOT: webRoot },
        stdout: 'pipe',
        stderr: 'pipe'
    },
    projects: [
        {
            name: 'desktop-chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 }
            }
        },
        {
            name: 'mobile-chromium',
            use: {
                ...devices['Pixel 5'],
                viewport: { width: 390, height: 844 }
            }
        },
        {
            name: 'narrow-mobile-chromium',
            testMatch: /responsive-accessibility\.spec\.mjs/,
            use: {
                ...devices['Pixel 5'],
                viewport: { width: 355, height: 800 }
            }
        },
        {
            name: 'wide-foldable-chromium',
            testMatch: /responsive-accessibility\.spec\.mjs/,
            use: {
                ...devices['Pixel 5'],
                viewport: { width: 440, height: 707 }
            }
        },
        {
            name: 'landscape-wide-chromium',
            testMatch: /responsive-accessibility\.spec\.mjs/,
            use: {
                ...devices['Pixel 5'],
                viewport: { width: 844, height: 390 }
            }
        },
        {
            name: 'landscape-compact-chromium',
            testMatch: /responsive-accessibility\.spec\.mjs/,
            use: {
                ...devices['Pixel 5'],
                viewport: { width: 740, height: 360 }
            }
        }
    ]
});
