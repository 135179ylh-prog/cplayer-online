import { test, expect } from '@playwright/test';
import {
    SEARCH_QUERY,
    SEARCH_RESULT,
    openSearch,
    submitSearch
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

function searchResult(index) {
    return {
        id: 900000 + index,
        name: `分页歌曲 ${String(index).padStart(2, '0')}`,
        artists: [{ name: '分页歌手' }],
        album: { name: '分页专辑', picUrl: '' }
    };
}

async function submitQuery(page, projectName, search, query) {
    await search.input.fill(query);
    if (projectName === 'mobile-chromium') {
        await search.input.press('Enter');
    } else {
        await page.locator('#searchButton').click();
    }
}

test('search loads every result page with honest progress', async ({ page }, testInfo) => {
    const requests = [];
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset'));
        requests.push({ limit, offset });
        const songs = offset === 0
            ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
            : Array.from({ length: 5 }, (_, index) => searchResult(index + 31));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { songs, total: 35 } })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);

    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);
    await expect(search.results.getByText('已显示 30 / 共 35 首')).toBeVisible();
    const loadMoreButton = search.results.getByRole('button', { name: '加载更多搜索结果' });
    const loadMoreBox = await loadMoreButton.boundingBox();
    expect(loadMoreBox?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await loadMoreButton.click();

    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(35);
    await expect(search.results.getByText('已显示 35 / 共 35 首')).toBeVisible();
    await expect(search.results.getByRole('button', { name: '加载更多搜索结果' })).toHaveCount(0);
    expect(requests).toEqual([
        { limit: 30, offset: 0 },
        { limit: 30, offset: 30 }
    ]);
});

test('duplicate result pages still advance by the API offset', async ({ page }, testInfo) => {
    const requests = [];
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get('offset'));
        requests.push(offset);
        const songs = offset === 0
            ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
            : offset === 30
                ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
                : Array.from({ length: 5 }, (_, index) => searchResult(index + 61));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { songs, total: 65 } })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);

    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);
    await expect(search.results.getByRole('button', { name: '加载更多搜索结果' })).toBeVisible();

    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(35);
    await expect(search.results.getByText('已显示 35 / 共 65 首')).toBeVisible();
    expect(requests).toEqual([0, 30, 60]);
});

test('an empty page with a reported total advances without looping', async ({ page }, testInfo) => {
    const requests = [];
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get('offset'));
        requests.push(offset);
        const songs = offset === 0
            ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
            : offset === 30
                ? []
                : Array.from({ length: 5 }, (_, index) => searchResult(index + 61));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { songs, total: 65 } })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();

    await expect(search.results.getByText('已显示 30 / 共 65 首')).toBeVisible();
    await expect(search.results.getByRole('button', { name: '加载更多搜索结果' })).toBeVisible();
    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();

    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(35);
    expect(requests).toEqual([0, 30, 60]);
});

test('search auto-loads the next page near the bottom on desktop and mobile', async ({ page }, testInfo) => {
    const requests = [];
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset'));
        requests.push({ limit, offset });
        const songs = offset === 0
            ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
            : Array.from({ length: 5 }, (_, index) => searchResult(index + 31));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { songs, total: 35 } })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);
    expect(requests).toEqual([{ limit: 30, offset: 0 }]);

    await search.results.evaluate((container) => {
        container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1000 }));
        container.scrollTop = container.scrollHeight;
        container.dispatchEvent(new Event('scroll'));
    });

    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(35);
    await expect(search.results.getByText('已显示 35 / 共 35 首')).toBeVisible();
    await expect(search.results.getByRole('button', { name: '加载更多搜索结果' })).toHaveCount(0);
    expect(requests).toEqual([
        { limit: 30, offset: 0 },
        { limit: 30, offset: 30 }
    ]);
});

test('touch-style pointer drag from a result button auto-loads the next page', async ({ page }, testInfo) => {
    const requests = [];
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset'));
        requests.push({ limit, offset });
        const songs = offset === 0
            ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
            : Array.from({ length: 5 }, (_, index) => searchResult(index + 31));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { songs, total: 35 } })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);

    await search.results.evaluate((container) => {
        const rowButton = container.querySelector('.js-play-search, .playlist-item button');
        rowButton?.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            pointerType: 'touch',
            buttons: 1
        }));
        rowButton?.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'touch',
            buttons: 1
        }));
        container.scrollTop = container.scrollHeight;
        container.dispatchEvent(new Event('scroll'));
    });

    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(35);
    await expect(search.results.getByText('已显示 35 / 共 35 首')).toBeVisible();
    expect(requests).toEqual([
        { limit: 30, offset: 0 },
        { limit: 30, offset: 30 }
    ]);
});

test('a failed next page keeps current songs and can retry', async ({ page }, testInfo) => {
    let nextPageAvailable = false;
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get('offset'));
        if (offset > 0 && !nextPageAvailable) {
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ code: 503, message: 'injected next-page failure' })
            });
            return;
        }
        const songs = offset === 0
            ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
            : Array.from({ length: 5 }, (_, index) => searchResult(index + 31));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: { songs, total: 35 } })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitQuery(page, testInfo.project.name, search, '分页失败测试');
    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();

    await expect(search.results.getByText('加载失败，已保留当前结果')).toBeVisible();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);
    await expect(search.results.getByRole('button', { name: '加载更多搜索结果' })).toHaveText('重试加载');

    nextPageAvailable = true;
    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(35);
    await expect(search.results.getByText('已显示 35 / 共 35 首')).toBeVisible();
});

test('a late page from an old query cannot enter the new query results', async ({ page }, testInfo) => {
    let releaseOldPage;
    let markOldPageStarted;
    const oldPageRelease = new Promise((resolve) => { releaseOldPage = resolve; });
    const oldPageStarted = new Promise((resolve) => { markOldPageStarted = resolve; });
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const query = url.searchParams.get('keyword');
        const offset = Number(url.searchParams.get('offset'));
        if (query === '旧歌手' && offset === 30) {
            markOldPageStarted();
            await oldPageRelease;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    code: 200,
                    data: { songs: [searchResult(31)], total: 31 }
                })
            });
            return;
        }
        const songs = query === '旧歌手'
            ? Array.from({ length: 30 }, (_, index) => searchResult(index + 1))
            : [{ ...searchResult(99), name: '新歌手结果' }];
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: { songs, total: query === '旧歌手' ? 31 : 1 }
            })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitQuery(page, testInfo.project.name, search, '旧歌手');
    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await oldPageStarted;

    await submitQuery(page, testInfo.project.name, search, '新歌手');
    await expect(search.results.getByText('新歌手结果')).toBeVisible();
    const oldResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/163_search') &&
            url.searchParams.get('keyword') === '旧歌手' &&
            url.searchParams.get('offset') === '30';
    });
    releaseOldPage();
    await oldResponse;
    await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    await expect(search.results.getByText('新歌手结果')).toBeVisible();
    await expect(search.results.getByText('分页歌曲 31')).toHaveCount(0);
    await expect(search.results.getByText('已显示 1 / 共 1 首')).toBeVisible();
});

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
