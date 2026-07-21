import { expect } from '@playwright/test';

export const SEARCH_QUERY = '质量基线测试';
export const SEARCH_RESULT = {
    id: 901001,
    name: '基线测试歌曲',
    artists: [{ name: '测试歌手' }],
    album: { name: '测试专辑', picUrl: '' },
    picUrl: ''
};

export function collectUnexpectedErrors(page, allowedPatterns = []) {
    const errors = [];
    const isAllowed = (text) => allowedPatterns.some((pattern) => pattern.test(text));

    page.on('pageerror', (error) => {
        const text = error && error.stack ? error.stack : String(error);
        if (!isAllowed(text)) errors.push(`pageerror: ${text}`);
    });
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!isAllowed(text)) errors.push(`console: ${text}`);
    });

    return errors;
}

export async function openSearch(page, projectName) {
    if (projectName === 'mobile-chromium') {
        await page.waitForFunction(() => Boolean(window.mobileUI));
        await page.getByRole('button', { name: '打开播放列表' }).click();
        const panel = page.locator('#mobilePlaylistSheet');
        await expect(panel).toHaveClass(/translate-y-0/);
        await expect(panel).toBeInViewport({ ratio: 1 });
        await page.locator('#sheetTabSearch').click();
        return {
            input: page.locator('#mobileSearchInput'),
            results: page.locator('#mobileSearchResults'),
            panel
        };
    }

    await page.getByRole('button', { name: '打开播放列表和搜索' }).click();
    const panel = page.locator('#floatingPlaylistPanel');
    await expect(panel).not.toHaveClass(/translate-x-full/);
    await expect(panel).toBeInViewport({ ratio: 1 });
    await page.locator('#desktopTabSearch').click();
    return {
        input: page.locator('#searchInput'),
        results: page.locator('#searchResults'),
        panel
    };
}

export async function submitSearch(page, projectName, input) {
    await input.fill(SEARCH_QUERY);
    if (projectName === 'mobile-chromium') {
        await input.press('Enter');
    } else {
        await page.locator('#searchButton').click();
    }
}

// Route the third-party search endpoint to a deterministic success payload.
// Returns a counter object so callers can assert the boundary was exercised.
export function mockSearchSuccess(page, results = [SEARCH_RESULT]) {
    const state = { requestCount: 0, urls: [] };
    page.route(/\/163_search\?/, async (route) => {
        state.requestCount += 1;
        state.urls.push(route.request().url());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 200, data: results })
        });
    });
    return state;
}

// Wait until the main module has defined its queue APIs on window. This is the
// only observable "app ready" proxy; there is no explicit DB-ready flag.
export async function waitForAppReady(page) {
    await page.waitForFunction(() => typeof window.addSongToQueueOnly === 'function'
        && Array.isArray(window.playlist));
}

// Read the persisted play-queue record straight from IndexedDB so tests assert
// real storage, not just in-memory state. Returns null when absent.
export async function readQueueRecord(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 3);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('playlists', 'readonly');
            const get = tx.objectStore('playlists').get('current_queue');
            get.onsuccess = () => { resolve(get.result || null); db.close(); };
            get.onerror = () => { reject(get.error); db.close(); };
        };
    }));
}

// List only the user-playlist records (id prefix user_pl_) from IndexedDB.
export async function readUserPlaylists(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('CPlayer5DB', 3);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('playlists', 'readonly');
            const all = tx.objectStore('playlists').getAll();
            all.onsuccess = () => {
                const rows = (all.result || []).filter((r) => String(r.id).startsWith('user_pl_'));
                resolve(rows);
                db.close();
            };
            all.onerror = () => { reject(all.error); db.close(); };
        };
    }));
}

// Open the shared music-library modal (desktop + mobile use the same element).
export async function openLibrary(page) {
    await page.evaluate(() => window.openMyPlaylists());
    await expect(page.locator('#myPlaylistsModal')).toBeVisible();
}

export async function openSettings(page) {
    await waitForAppReady(page);
    await page.getByRole('button', { name: '打开设置' }).click();
    await expect(page.locator('#settingsModal')).toBeVisible();
}

export async function closeSettings(page) {
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(page.locator('#settingsModal')).toBeHidden();
}
