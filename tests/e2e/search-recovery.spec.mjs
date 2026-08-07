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
    const requests = [];
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get('offset'));
        requests.push(offset);
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
    // The retry must re-request the failed cursor: never replay page one and
    // never skip past the page that failed. The transport retries a 5xx once,
    // so the failed cursor legitimately appears more than once.
    expect(requests[0]).toBe(0);
    expect(requests.slice(1)).not.toHaveLength(0);
    expect(new Set(requests.slice(1))).toEqual(new Set([30]));
    expect(requests.filter((offset) => offset === 0)).toHaveLength(1);
});

test('the paging cursor never rewinds and never fetches a page twice', async ({ page }, testInfo) => {
    // The in-flight guard makes truly concurrent same-query paging unreachable
    // through the UI, so this locks the guard itself: while a page is loading the
    // control is disabled and scroll cannot start a second request for the same
    // cursor. That is what keeps the cursor monotonic and rows unduplicated.
    const requests = [];
    let releaseSecondPage;
    let markSecondPageStarted;
    const secondPageRelease = new Promise((resolve) => { releaseSecondPage = resolve; });
    const secondPageStarted = new Promise((resolve) => { markSecondPageStarted = resolve; });

    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get('offset'));
        requests.push(offset);
        if (offset === 30) {
            markSecondPageStarted();
            await secondPageRelease;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: {
                    songs: Array.from({ length: 30 }, (_, index) => searchResult(offset + index + 1)),
                    total: 95
                }
            })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);

    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await secondPageStarted;

    // Mid-flight the control must be disabled, and neither a scroll nor a direct
    // activation of the control's own handler may start a second request for the
    // cursor that is already in flight. Dispatching click straight at the element
    // bypasses the disabled-button affordance and reaches the load handler, so the
    // in-flight guard itself is what has to hold here.
    const loadMore = search.results.getByRole('button', { name: '加载更多搜索结果' });
    await expect(loadMore).toBeDisabled();
    await expect(loadMore).toHaveText('加载中…');
    await search.results.evaluate((container) => {
        container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 2000 }));
        container.scrollTop = container.scrollHeight;
        container.dispatchEvent(new Event('scroll'));
        const control = container.querySelector('button[aria-label="加载更多搜索结果"]');
        for (let attempt = 0; attempt < 3; attempt += 1) {
            control?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
    });
    await page.waitForTimeout(300);
    expect(requests).toEqual([0, 30]);

    const secondResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/163_search') && url.searchParams.get('offset') === '30';
    });
    releaseSecondPage();
    await secondResponse;

    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(60);
    await expect(search.results.getByText('已显示 60 / 共 95 首')).toBeVisible();

    // No offset may be requested twice, and no row may be rendered twice.
    expect(requests).toEqual([...new Set(requests)]);
    const labels = await search.results
        .getByRole('button', { name: /添加并播放「分页歌曲/ })
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    expect(new Set(labels).size).toBe(labels.length);
});

test('going offline mid-paging keeps loaded songs and recovers after reconnect', async ({ page }, testInfo) => {
    const requests = [];
    // context.setOffline cannot reach a route that is fulfilled before the network
    // layer, so the offline window is modelled by failing the request the way a
    // browser does when the connection is gone, plus navigator.onLine === false.
    let offline = false;
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get('offset'));
        requests.push(offset);
        if (offline) {
            await route.abort('internetdisconnected');
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: {
                    songs: Array.from({ length: 30 }, (_, index) => searchResult(offset + index + 1)),
                    total: 65
                }
            })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);

    // A dropped connection must never discard the page the user already has.
    offline = true;
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        window.dispatchEvent(new Event('offline'));
    });
    try {
        await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
        await expect(search.results.getByText('加载失败，已保留当前结果')).toBeVisible();
        await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);
        await expect(search.results.getByText('已显示 30 / 共 65 首')).toBeVisible();
        await expect(search.results.getByRole('button', { name: '加载更多搜索结果' })).toHaveText('重试加载');
    } finally {
        offline = false;
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
            window.dispatchEvent(new Event('online'));
        });
    }

    // Reconnecting must resume at the failed cursor, not restart from page one.
    const beforeRetry = [...requests];
    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(60);
    await expect(search.results.getByText('已显示 60 / 共 65 首')).toBeVisible();

    expect(beforeRetry[0]).toBe(0);
    expect(requests.filter((offset) => offset === 0)).toHaveLength(1);
    expect(new Set(requests.slice(1))).toEqual(new Set([30]));
});

test('a search page that times out preserves results and retries the same cursor', async ({ page }, testInfo) => {
    const requests = [];
    let failNextPage = true;
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const offset = Number(url.searchParams.get('offset'));
        requests.push(offset);
        if (offset > 0 && failNextPage) {
            // A stalled connection surfaces as a fetch-level failure, which is a
            // different path from the HTTP 5xx the neighbouring test covers.
            await route.abort('timedout');
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: {
                    songs: Array.from({ length: 30 }, (_, index) => searchResult(offset + index + 1)),
                    total: 65
                }
            })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitSearch(page, testInfo.project.name, search.input);
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);

    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await expect(search.results.getByText('加载失败，已保留当前结果')).toBeVisible();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(30);

    failNextPage = false;
    await search.results.getByRole('button', { name: '加载更多搜索结果' }).click();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(60);
    await expect(search.results.getByText('已显示 60 / 共 65 首')).toBeVisible();

    expect(requests.filter((offset) => offset === 0)).toHaveLength(1);
    expect(new Set(requests.slice(1))).toEqual(new Set([30]));
});

test('a late first page from an old query cannot replace the new query results', async ({ page }, testInfo) => {
    let releaseOldFirstPage;
    let markOldFirstPageStarted;
    const oldFirstPageRelease = new Promise((resolve) => { releaseOldFirstPage = resolve; });
    const oldFirstPageStarted = new Promise((resolve) => { markOldFirstPageStarted = resolve; });
    await page.route(/\/163_search\?/, async (route) => {
        const url = new URL(route.request().url());
        const query = url.searchParams.get('keyword');
        if (query === '慢歌手') {
            markOldFirstPageStarted();
            await oldFirstPageRelease;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    code: 200,
                    data: {
                        songs: Array.from({ length: 30 }, (_, index) => searchResult(index + 1)),
                        total: 60
                    }
                })
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: { songs: [{ ...searchResult(98), name: '快歌手结果' }], total: 1 }
            })
        });
    });

    await page.goto('/index.html');
    const search = await openSearch(page, testInfo.project.name);
    await submitQuery(page, testInfo.project.name, search, '慢歌手');
    await oldFirstPageStarted;

    await submitQuery(page, testInfo.project.name, search, '快歌手');
    await expect(search.results.getByText('快歌手结果')).toBeVisible();
    const oldResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/163_search') && url.searchParams.get('keyword') === '慢歌手';
    });
    releaseOldFirstPage();
    await oldResponse;
    await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    await expect(search.results.getByText('快歌手结果')).toBeVisible();
    await expect(search.results.getByRole('button', { name: /添加并播放「分页歌曲/ })).toHaveCount(0);
    await expect(search.results.getByText('已显示 1 / 共 1 首')).toBeVisible();
    await expect(search.results.getByRole('button', { name: '加载更多搜索结果' })).toHaveCount(0);
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
