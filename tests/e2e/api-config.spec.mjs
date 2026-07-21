import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
    SEARCH_QUERY,
    SEARCH_RESULT,
    closeSettings,
    mockSearchSuccess,
    openSearch,
    openSettings,
    submitSearch
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

test('saved API key and base are applied to search requests', async ({ page }, testInfo) => {
    const testKey = `e2e+/${randomUUID()}?`;
    const customBase = 'https://api.example.test/custom-api';
    const searchMock = mockSearchSuccess(page);

    await page.goto('/index.html');
    await openSettings(page);
    await page.locator('#settingsApiKeyInput').fill(testKey);
    await page.locator('#settingsApiBaseInput').fill(`${customBase}/`);
    await page.locator('#settingsApiSaveBtn').click();

    await expect(page.locator('#copyToast span')).toHaveText('API 设置已保存');
    await expect.poll(() => page.evaluate(() => ({
        key: localStorage.getItem('cp_api_key'),
        base: localStorage.getItem('cp_api_base')
    }))).toEqual({ key: testKey, base: customBase });

    await closeSettings(page);
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByText(SEARCH_RESULT.name)).toBeVisible();

    const requestUrl = new URL(searchMock.urls.at(-1));
    expect(requestUrl.origin + requestUrl.pathname).toBe(`${customBase}/163_search`);
    expect(requestUrl.searchParams.get('apikey')).toBe(testKey);
    expect(requestUrl.searchParams.get('keyword')).toBe(SEARCH_QUERY);
});

test('JSON auth failure shows actionable search recovery', async ({ page }, testInfo) => {
    await page.route(/\/163_search\?/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 401, msg: 'missing runtime test key' })
    }));

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);

    await expect(search.results.getByRole('status')).toContainText(
        'API 密钥无效或额度已用完，请在设置中检查密钥'
    );
    await expect(search.input).toHaveValue(SEARCH_QUERY);
    await expect(search.panel).toBeVisible();
});

test('HTTP auth failure shows the same actionable search recovery', async ({ page }, testInfo) => {
    await page.route(/\/163_search\?/, (route) => route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 401, msg: 'missing runtime test key' })
    }));

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);

    await expect(search.results.getByRole('status')).toContainText(
        'API 密钥无效或额度已用完，请在设置中检查密钥'
    );
    await expect(search.input).toHaveValue(SEARCH_QUERY);
});

test('remote playlist auth failure keeps the actionable key message', async ({ page }) => {
    await page.route(/\/163_playlist\?/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 403, msg: 'invalid runtime test key' })
    }));

    await page.goto('/index.html');
    await openSettings(page);
    await page.locator('#playlistIdInput').fill('123456');
    await page.locator('#loadPlaylistBtn').click();

    await expect(page.locator('#settingsModal')).toBeHidden();
    await expect(page.locator('#copyToast span')).toHaveText(
        'API 密钥无效或额度已用完，请在设置中检查密钥'
    );
});

test('invalid API base is rejected without persisting either setting', async ({ page }) => {
    const testKey = `e2e-${randomUUID()}`;

    await page.goto('/index.html');
    await openSettings(page);
    await page.locator('#settingsApiKeyInput').fill(testKey);
    await page.locator('#settingsApiBaseInput').fill('https://');
    await page.locator('#settingsApiSaveBtn').click();

    await expect(page.locator('#copyToast span')).toHaveText('请输入有效的 HTTP(S) API 地址');
    await expect.poll(() => page.evaluate(() => ({
        key: localStorage.getItem('cp_api_key'),
        base: localStorage.getItem('cp_api_base')
    }))).toEqual({ key: null, base: null });
});

test('reset removes custom API settings and restores key-free default requests', async ({ page }, testInfo) => {
    const testKey = `e2e-${randomUUID()}`;
    const customBase = 'https://api.example.test/custom-api';
    await page.addInitScript(({ key, base }) => {
        localStorage.setItem('cp_api_key', key);
        localStorage.setItem('cp_api_base', base);
    }, { key: testKey, base: customBase });
    const searchMock = mockSearchSuccess(page);

    await page.goto('/index.html');
    await openSettings(page);
    await expect(page.locator('#settingsApiKeyInput')).toHaveValue(testKey);
    await expect(page.locator('#settingsApiBaseInput')).toHaveValue(customBase);
    await page.locator('#settingsApiResetBtn').click();

    await expect(page.locator('#settingsApiKeyInput')).toHaveValue('');
    await expect(page.locator('#settingsApiBaseInput')).toHaveValue('https://api.chksz.top/api');
    await expect.poll(() => page.evaluate(() => ({
        key: localStorage.getItem('cp_api_key'),
        base: localStorage.getItem('cp_api_base')
    }))).toEqual({ key: null, base: null });

    await closeSettings(page);
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByText(SEARCH_RESULT.name)).toBeVisible();

    const requestUrl = new URL(searchMock.urls.at(-1));
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://api.chksz.top/api/163_search');
    expect(requestUrl.searchParams.has('apikey')).toBe(false);
});
