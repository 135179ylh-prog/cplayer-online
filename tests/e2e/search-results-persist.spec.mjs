import { test, expect } from '@playwright/test';
import { mockSearchSuccess, openSearch, submitSearch, waitForAppReady } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

const SONGS = [
    { id: 990001, name: '连续添加歌曲甲', artists: [{ name: '连续歌手' }], album: { name: '连续专辑', picUrl: '' }, picUrl: '' },
    { id: 990002, name: '连续添加歌曲乙', artists: [{ name: '连续歌手' }], album: { name: '连续专辑', picUrl: '' }, picUrl: '' },
    { id: 990003, name: '连续添加歌曲丙', artists: [{ name: '连续歌手' }], album: { name: '连续专辑', picUrl: '' }, picUrl: '' }
];

function routeSongDetail(page) {
    return page.route(/\/163_music\?/, async (route) => {
        const id = new URL(route.request().url()).searchParams.get('id') || '';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 200,
                data: {
                    id: Number(id), name: 'x', artist: 'y', picUrl: '',
                    url: `https://media.example.test/${id}.mp3`, level: 'standard', br: 128000
                }
            })
        });
    });
}

// Playing a search result used to hide the result list and clear the query, so
// adding a second song meant searching again. Neither the add-to-queue button
// beside it nor the mobile row did that.
test('playing a search result keeps the results and the query', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    // Mobile deliberately closes the sheet to reveal the player, so this
    // invariant is desktop-only. The mobile row keeps its own results intact.
    test.skip(projectName === 'mobile-chromium', 'mobile closes the sheet by design');
    mockSearchSuccess(page, SONGS);
    await routeSongDetail(page);

    await page.goto('/index.html');
    await waitForAppReady(page);
    const search = await openSearch(page, projectName);
    await submitSearch(page, projectName, search.input);

    const rows = search.results.getByRole('button', { name: /添加并播放「连续添加歌曲/ });
    await expect(rows).toHaveCount(SONGS.length);
    const queryBefore = await search.input.inputValue();

    await rows.first().click();
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(1);

    // The list must still be usable for a second pick, without re-searching.
    await expect(search.results).toBeVisible();
    await expect(rows).toHaveCount(SONGS.length);
    expect(await search.input.inputValue()).toBe(queryBefore);

    await rows.nth(1).click();
    await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(2);
    await expect(search.results).toBeVisible();

    const queuedIds = await page.evaluate(() => window.playlist.map((song) => song.id));
    expect(queuedIds).toContain(SONGS[0].id);
    expect(queuedIds).toContain(SONGS[1].id);
});
