import { test, expect } from '@playwright/test';
import {
    mockSearchSuccess,
    openSearch,
    submitSearch,
    waitForAppReady,
    readUserPlaylists
} from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

const SONGS = [
    { id: 980001, name: '队列收藏歌曲甲', artists: [{ name: '收藏歌手' }], album: { name: '收藏专辑', picUrl: '' }, picUrl: '' },
    { id: 980002, name: '队列收藏歌曲乙', artists: [{ name: '收藏歌手' }], album: { name: '收藏专辑', picUrl: '' }, picUrl: '' }
];

async function seedQueue(page, projectName) {
    const search = await openSearch(page, projectName);
    await submitSearch(page, projectName, search.input);
    const add = search.results.getByRole('button', { name: '加入播放列表（不立即播放）' });
    await expect(add).toHaveCount(SONGS.length);
    for (let index = 0; index < SONGS.length; index += 1) {
        await add.nth(index).click();
        await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(index + 1);
    }
    return page.evaluate(() => window.playlist.map((song) => song.id));
}

// A song sitting in the play queue must be savable to a user playlist. The
// desktop queue row offered no way to do that while the mobile sheet row did, so
// this covers the row action on both layouts.
test('a queued song can be saved to a playlist from the queue row', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    mockSearchSuccess(page, SONGS);

    await page.goto('/index.html');
    await waitForAppReady(page);
    const queueIds = await seedQueue(page, projectName);

    const existing = await readUserPlaylists(page);

    // Switch back from the search surface to the queue list, the way a user does.
    if (projectName === 'mobile-chromium') {
        await page.locator('#sheetTabPlaylist').click();
    } else {
        await page.locator('#desktopTabPlaylist').click();
    }

    // The row action lives in whichever queue surface this layout renders.
    const rowContainer = projectName === 'mobile-chromium'
        ? page.locator('#mobilePlaylistContainer')
        : page.locator('#playlistContent');
    const saveButton = rowContainer.locator('.js-add-playlist-item').first();
    await expect(saveButton, 'the queue row must offer a save-to-playlist action').toHaveCount(1);

    await expect(saveButton).toBeVisible();
    await saveButton.click();
    await expect(page.locator('#userPlaylistModal')).toBeVisible();

    // Create a playlist from inside the modal and confirm the song lands in it.
    await page.locator('#modalNewPlaylistName').fill('队列收藏目标');
    await page.locator('#createPlaylistInModalBtn').click();

    await expect.poll(async () => {
        const lists = await readUserPlaylists(page);
        const target = lists.find((list) => list.name === '队列收藏目标');
        return target ? target.songs.length : 0;
    }, { timeout: 8_000 }).toBe(1);

    const lists = await readUserPlaylists(page);
    const target = lists.find((list) => list.name === '队列收藏目标');
    expect(target.songs[0].id).toBe(queueIds[0]);
    expect(lists.length).toBe(existing.length + 1);

    // Saving must not disturb the queue itself.
    expect(await page.evaluate(() => window.playlist.length)).toBe(SONGS.length);
});
