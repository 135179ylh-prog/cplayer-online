import { test, expect } from '@playwright/test';
import {
    SEARCH_QUERY,
    SEARCH_RESULT,
    openSearch,
    submitSearch
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

test('search failure retains context and retry renders results', async ({ page }, testInfo) => {
    let serviceAvailable = false;
    let failedRequestCount = 0;
    let successfulRequestCount = 0;
    await page.route(/\/163_search\?/, async (route) => {
        if (!serviceAvailable) {
            failedRequestCount += 1;
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ code: 503, message: 'injected failure' })
            });
            return;
        }
        successfulRequestCount += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: [SEARCH_RESULT] })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);

    const recovery = search.results.getByRole('status');
    await expect(recovery).toContainText('搜索服务暂不可用');
    await expect(search.input).toHaveValue(SEARCH_QUERY);
    await expect(search.panel).toBeVisible();

    const retryButton = search.results.getByRole('button', {
        name: `重试搜索：${SEARCH_QUERY}`
    });
    await expect(retryButton).toBeVisible();
    serviceAvailable = true;
    await retryButton.click();

    await expect(search.results.getByText(SEARCH_RESULT.name)).toBeVisible();
    await expect(search.results.getByText('测试歌手')).toBeVisible();
    await expect(search.input).toHaveValue(SEARCH_QUERY);
    await expect(search.panel).toBeVisible();
    expect(failedRequestCount).toBeGreaterThanOrEqual(2);
    expect(successfulRequestCount).toBeGreaterThanOrEqual(1);
});
