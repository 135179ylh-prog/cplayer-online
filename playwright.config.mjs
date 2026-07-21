import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PW_PORT || 4173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: 1,
    timeout: 30_000,
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
        }
    ]
});
