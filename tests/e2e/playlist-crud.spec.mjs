import { test, expect } from '@playwright/test';
import { waitForAppReady, readUserPlaylists, openLibrary } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

// P1: user playlists can be created and deleted through the library UI, and both
// operations are reflected in IndexedDB (the user_pl_ records). Delete is gated
// by a native confirm() dialog.
test('user playlist create and delete round-trips through storage', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);
    expect(await readUserPlaylists(page)).toHaveLength(0);

    await openLibrary(page);

    // Create through the real input + button.
    await page.locator('#myNewPlaylistName').fill('我的测试歌单');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect(page.locator('#copyToast span')).toContainText('歌单已创建');

    await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(1);
    const created = await readUserPlaylists(page);
    expect(created[0].name).toBe('我的测试歌单');
    expect(created[0].songs).toHaveLength(0);
    expect(String(created[0].id)).toMatch(/^user_pl_/);

    // The library list and count badge reflect the new playlist.
    await expect(page.locator('#libraryPlaylistCount')).toHaveText('1');
    await expect(page.locator('#myPlaylistsList').getByText('我的测试歌单')).toBeVisible();

    // Delete: accept the confirm dialog, then verify removal from storage.
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除歌单「我的测试歌单」' }).click();

    await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(0);
    await expect(page.locator('#libraryPlaylistCount')).toHaveText('0');
    await expect(page.locator('#myPlaylistsList')).toContainText('还没有自建歌单');
});

// P1: dismissing the delete confirm dialog keeps the playlist intact.
test('dismissing delete confirm keeps the playlist', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    await openLibrary(page);
    await page.locator('#myNewPlaylistName').fill('保留歌单');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect.poll(async () => (await readUserPlaylists(page)).length).toBe(1);

    // Dismiss the confirm dialog: the playlist must survive.
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: '删除歌单「保留歌单」' }).click();

    // Give the (cancelled) handler a beat, then confirm nothing was deleted.
    await page.waitForTimeout(200);
    const after = await readUserPlaylists(page);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('保留歌单');
});

// P1: creating with an empty name is rejected with feedback and no record.
test('empty playlist name is rejected', async ({ page }) => {
    await page.goto('/index.html');
    await waitForAppReady(page);

    await openLibrary(page);
    await page.locator('#myNewPlaylistName').fill('   ');
    await page.locator('#myCreatePlaylistBtn').click();
    await expect(page.locator('#copyToast span')).toContainText('请输入歌单名称');
    expect(await readUserPlaylists(page)).toHaveLength(0);
});
