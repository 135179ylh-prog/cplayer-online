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
