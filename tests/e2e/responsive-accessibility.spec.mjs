import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForAppReady } from './helpers.mjs';

test.use({ serviceWorkers: 'block' });

function makeSilentWav(seconds = 10) {
    const sampleRate = 8000;
    const dataSize = sampleRate * seconds;
    const wav = Buffer.alloc(44 + dataSize, 128);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataSize, 40);
    return wav;
}

function isMobileProject(testInfo) {
    return testInfo.project.name !== 'desktop-chromium';
}

function isLandscapeProject(testInfo) {
    return testInfo.project.name.startsWith('landscape-');
}

async function waitForResponsiveAppReady(page, testInfo) {
    await waitForAppReady(page);
    if (isMobileProject(testInfo)) {
        await page.waitForFunction(() => Boolean(window.mobileUI));
    }
}

function activePanelIds(testInfo) {
    return isMobileProject(testInfo)
        ? {
            trigger: '#mobilePlaylistToggleBtn',
            panel: '#mobilePlaylistSheet',
            playlistTab: '#sheetTabPlaylist',
            searchTab: '#sheetTabSearch',
            playlistPanel: '#sheetContentPlaylist',
            searchPanel: '#sheetContentSearch'
        }
        : {
            trigger: '#togglePlaylistBtn',
            panel: '#floatingPlaylistPanel',
            playlistTab: '#desktopTabPlaylist',
            searchTab: '#desktopTabSearch',
            playlistPanel: '#desktopContentPlaylist',
            searchPanel: '#desktopContentSearch'
        };
}

async function expectNoSeriousAxeViolations(page, include) {
    const builder = new AxeBuilder({ page });
    if (include) builder.include(include);
    const results = await builder.analyze();
    const violations = results.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    const message = violations.map((item) => `${item.id}: ${item.help} (${item.nodes.length} nodes)`).join('\n');
    expect(violations, message).toEqual([]);
}

test('responsive shell has no horizontal overflow or undersized mobile targets', async ({ page }, testInfo) => {
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    if (isMobileProject(testInfo)) {
        await expect(page.locator('#mobileLayout')).toBeVisible();
        await expect(page.locator('#desktopLayout')).toBeHidden();
    } else {
        await expect(page.locator('#desktopLayout')).toBeVisible();
        await expect(page.locator('#mobileLayout')).toBeHidden();
    }

    const geometry = await page.evaluate(() => {
        const interactive = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"], [role="slider"]')]
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return !element.closest('[inert]') && !element.disabled
                    && style.display !== 'none' && style.visibility !== 'hidden'
                    && rect.width > 0 && rect.height > 0;
            });
        return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            outside: interactive.filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.left < -0.5 || rect.right > innerWidth + 0.5;
            }).map((element) => element.id || element.getAttribute('aria-label') || element.tagName),
            undersized: interactive.filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width < 44 || rect.height < 44;
            }).map((element) => element.id || element.getAttribute('aria-label') || element.tagName)
        };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.outside).toEqual([]);
    if (isMobileProject(testInfo)) expect(geometry.undersized).toEqual([]);
});

test('compact landscape keeps the mobile player and core controls inside the viewport', async ({ page }, testInfo) => {
    test.skip(!isLandscapeProject(testInfo), 'The compact landscape contract applies only to landscape projects.');
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    await expect(page.locator('#mobileLayout')).toBeVisible();
    await expect(page.locator('#desktopLayout')).toBeHidden();

    const ids = [
        'mobileViewToggle',
        'mobileSettingsBtn',
        'mobileVinylContainer',
        'mobileTitle',
        'mobileArtist',
        'mobileMetaContainer',
        'mobileProgressBarContainer',
        'mobileModeBtn',
        'mobilePrevBtn',
        'mobilePlayBtn',
        'mobileNextBtn',
        'mobilePlaylistToggleBtn',
        'mClearQueueBtnBar',
        'myPlaylistsBtn'
    ];
    const geometry = await page.evaluate((targetIds) => {
        const rects = Object.fromEntries(targetIds.map((id) => {
            const element = document.getElementById(id);
            const rect = element?.getBoundingClientRect();
            const style = element ? getComputedStyle(element) : null;
            return [id, rect ? {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity
            } : null];
        }));
        const main = document.getElementById('mobileMainView')?.getBoundingClientRect();
        const controls = document.getElementById('mobileBottomControls')?.getBoundingClientRect();
        return {
            rects,
            main: main && { left: main.left, right: main.right, top: main.top, bottom: main.bottom },
            controls: controls && { left: controls.left, right: controls.right, top: controls.top, bottom: controls.bottom },
            grid: getComputedStyle(document.getElementById('mobileLayout')).gridTemplateColumns
        };
    }, ids);

    const visibleRects = Object.values(geometry.rects);
    expect(visibleRects.every((rect) => rect && rect.width > 0 && rect.height > 0
        && rect.display !== 'none' && rect.visibility !== 'hidden' && Number(rect.opacity) > 0)).toBe(true);
    const viewport = page.viewportSize();
    const viewportOutside = Object.entries(geometry.rects).filter(([, rect]) =>
        rect.left < -0.5 || rect.top < -0.5 || rect.right > viewport.width + 0.5 || rect.bottom > viewport.height + 0.5);
    expect(viewportOutside).toEqual([]);
    expect(geometry.main.right).toBeLessThanOrEqual(geometry.controls.left + 0.5);
    expect(geometry.grid).not.toBe('none');

    const rect = (id) => geometry.rects[id];
    expect(rect('mobileVinylContainer').bottom).toBeLessThanOrEqual(rect('mobileTitle').top + 0.5);
    expect(rect('mobileTitle').bottom).toBeLessThanOrEqual(rect('mobileArtist').top + 0.5);
    expect(rect('mobileArtist').bottom).toBeLessThanOrEqual(rect('mobileMetaContainer').top + 0.5);
    expect(rect('mobileProgressBarContainer').bottom).toBeLessThanOrEqual(rect('mobileModeBtn').top + 0.5);
    for (const [leftId, rightId] of [
        ['mobileModeBtn', 'mobilePrevBtn'],
        ['mobilePrevBtn', 'mobilePlayBtn'],
        ['mobilePlayBtn', 'mobileNextBtn'],
        ['mobileNextBtn', 'mobilePlaylistToggleBtn'],
        ['mClearQueueBtnBar', 'myPlaylistsBtn']
    ]) {
        expect(rect(leftId).right).toBeLessThanOrEqual(rect(rightId).left + 0.5);
    }
});

test('mobile playlist sheet stays open when rotating into compact landscape', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'The rotation regression uses the standard mobile project as its portrait start.');
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    const trigger = page.locator('#mobilePlaylistToggleBtn');
    const sheet = page.locator('#mobilePlaylistSheet');
    await trigger.click();
    await expect(sheet).toHaveAttribute('aria-hidden', 'false');
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('#mobileLayout')).toBeVisible();
    await expect(page.locator('#desktopLayout')).toBeHidden();
    await expect(sheet).toHaveAttribute('aria-hidden', 'false');
    await expect.poll(() => sheet.evaluate((element) => element.inert)).toBe(false);
});

test('dialogs contain focus, isolate the background, and restore the opener', async ({ page }, testInfo) => {
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    const trigger = isMobileProject(testInfo) ? '#mobileSettingsBtn' : '#settingsBtn';
    await page.locator(trigger).click();
    await expect(page.locator('#closeSettingsBtn')).toBeFocused();
    const background = page.locator(isMobileProject(testInfo) ? '#mobileLayout' : '#desktopLayout');
    await expect.poll(() => background.evaluate((element) => element.inert)).toBe(true);

    const lastFocusableTag = await page.locator('#settingsModal').evaluate((modal) => {
        const items = [...modal.querySelectorAll('button, input, select, summary, [tabindex]:not([tabindex="-1"])')]
            .filter((element) => !element.disabled && element.getClientRects().length > 0);
        const last = items[items.length - 1];
        last.focus();
        return last && last.tagName;
    });
    expect(lastFocusableTag).toBeTruthy();
    await page.keyboard.press('Tab');
    await expect(page.locator('#closeSettingsBtn')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => document.getElementById('settingsModal').contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('#settingsModal')).toBeHidden();
    await expect(page.locator(trigger)).toBeFocused();
});

test('playlist panels expose state, support arrow tabs, and close with Escape', async ({ page }, testInfo) => {
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    const ids = activePanelIds(testInfo);
    const trigger = page.locator(ids.trigger);
    const panel = page.locator(ids.panel);
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => panel.evaluate((element) => element.inert)).toBe(true);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await expect.poll(() => panel.evaluate((element) => element.inert)).toBe(false);
    await expect(page.locator(ids.playlistTab)).toBeFocused();
    const tablistChildren = await panel.locator('[role="tablist"]').evaluate((element) =>
        [...element.children].map((child) => child.getAttribute('role') || child.tagName.toLowerCase())
    );
    expect(tablistChildren).toEqual(['tab', 'tab']);
    await expectNoSeriousAxeViolations(page, ids.panel);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(ids.searchTab)).toBeFocused();
    await expect(page.locator(ids.searchTab)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => page.locator(ids.playlistPanel).evaluate((element) => element.inert)).toBe(true);
    await expect.poll(() => page.locator(ids.searchPanel).evaluate((element) => element.inert)).toBe(false);
    await expectNoSeriousAxeViolations(page, ids.panel);

    await page.keyboard.press('Escape');
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => panel.evaluate((element) => element.inert)).toBe(true);
    await expect(trigger).toBeFocused();
});

test('nested playlist detail closes only the top dialog', async ({ page }, testInfo) => {
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    const libraryTrigger = page.locator(isMobileProject(testInfo) ? '#myPlaylistsBtn' : '#musicLibraryBtn');
    await libraryTrigger.click();
    await expect(page.locator('#myPlaylistsModal')).toBeVisible();
    await page.locator('#myNewPlaylistName').fill('无障碍测试歌单');
    await page.locator('#myCreatePlaylistBtn').click();
    const manage = page.getByRole('button', { name: '管理歌单「无障碍测试歌单」' });
    await expect(manage).toBeVisible();
    await manage.click();
    await expect(page.locator('#playlistDetailModal')).toBeVisible();
    await expect(page.locator('#closePlaylistDetailBtn')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('#playlistDetailModal')).toBeHidden();
    await expect(page.locator('#myPlaylistsModal')).toBeVisible();
    await expect(manage).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('#myPlaylistsModal')).toBeHidden();
    await expect(libraryTrigger).toBeFocused();
});

test('progress slider responds to keyboard commands', async ({ page }, testInfo) => {
    let appOrigin = '';
    const wav = makeSilentWav();
    await page.route(/\/tests\/e2e\/fixtures\/keyboard-progress\.wav$/, (route) => {
        const range = route.request().headers().range;
        if (!range) {
            return route.fulfill({
                status: 200,
                contentType: 'audio/wav',
                headers: { 'Accept-Ranges': 'bytes' },
                body: wav
            });
        }
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (!match) return route.fulfill({ status: 416, body: '' });
        const start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : wav.length - 1;
        const end = Math.min(requestedEnd, wav.length - 1);
        return route.fulfill({
            status: 206,
            contentType: 'audio/wav',
            headers: {
                'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${end}/${wav.length}`
            },
            body: wav.subarray(start, end + 1)
        });
    });
    await page.route(/\/163_music\?/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            code: 200,
            data: {
                id: 902001,
                name: '进度键盘测试歌曲',
                artist: '测试歌手',
                picUrl: '',
                level: 'standard',
                url: `${appOrigin}/tests/e2e/fixtures/keyboard-progress.wav`
            }
        })
    }));
    await page.route(/\/163_lyric\?/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, data: { lrc: '', tlrc: '' } })
    }));
    await page.goto('/index.html');
    appOrigin = new URL(page.url()).origin;
    await waitForResponsiveAppReady(page, testInfo);
    await page.evaluate(() => {
        window.addSongToQueueOnly({ id: 902001, name: '进度键盘测试歌曲', artist: '测试歌手' });
        window.playSongAtIndex(0);
    });
    const slider = page.locator(isMobileProject(testInfo) ? '#mobileProgressBarContainer' : '#progressBarContainer');
    await expect(slider).toHaveAttribute('aria-disabled', 'false');
    const playButton = page.locator(isMobileProject(testInfo) ? '#mobilePlayBtn' : '#playPauseBtn');
    const iconClass = await playButton.locator('i').getAttribute('class');
    if (iconClass && iconClass.includes('fa-pause')) await playButton.click();
    await expect(playButton.locator('i')).toHaveClass(/fa-play/);
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuetext', '0:05 / 0:10');
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('aria-valuenow', '100');
});

test('mobile cover and lyrics views have an explicit accessible toggle', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), 'The cover/lyrics view exists only in the mobile layout.');
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    const toggle = page.locator('#mobileViewToggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#mobileLyricsPage')).toHaveAttribute('aria-hidden', 'false');
    await expect.poll(() => page.locator('#mobileLyricsPage').evaluate((element) => element.inert)).toBe(false);
    await expect.poll(() => page.locator('#mobileCoverContainer').evaluate((element) => element.inert)).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('search song primary action is a keyboard-operable button', async ({ page }, testInfo) => {
    const searchResult = {
        id: 901001,
        name: '无障碍测试歌曲',
        artists: [{ name: '测试歌手' }],
        album: { name: '测试专辑', picUrl: '' },
        picUrl: ''
    };
    let songRequests = 0;
    await page.route(/\/163_search\?/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, data: [searchResult] })
    }));
    await page.route(/\/163_music\?/, async (route) => {
        songRequests += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ code: 401, msg: 'runtime test auth boundary' })
        });
    });
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    const ids = activePanelIds(testInfo);
    await page.locator(ids.trigger).click();
    await expect(page.locator(ids.panel)).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator(ids.playlistTab)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(ids.searchTab)).toHaveAttribute('aria-selected', 'true');
    const input = page.locator(isMobileProject(testInfo) ? '#mobileSearchInput' : '#searchInput');
    await input.fill('无障碍测试');
    await input.press('Enter');
    const results = page.locator(isMobileProject(testInfo) ? '#mobileSearchResults' : '#searchResults');
    const playButton = results.getByRole('button', { name: '添加并播放「无障碍测试歌曲」' });
    await expect(playButton).toBeVisible();
    await playButton.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => songRequests).toBe(1);
});

test('core shell and settings dialog have no serious Axe violations', async ({ page }, testInfo) => {
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    await expectNoSeriousAxeViolations(page);
    await page.locator(isMobileProject(testInfo) ? '#mobileSettingsBtn' : '#settingsBtn').click();
    await expect(page.locator('#settingsModal')).toBeVisible();
    await expect(page.locator('#settingsModal')).toHaveCSS('opacity', '1');
    await expectNoSeriousAxeViolations(page, '#settingsModal');
});

test('mobile safe-area variables reach the real layout controls and sheet', async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), 'Safe-area ownership applies to the mobile layout.');
    await page.goto('/index.html');
    await waitForResponsiveAppReady(page, testInfo);
    await page.evaluate(() => {
        const root = document.documentElement;
        root.style.setProperty('--cp-safe-area-top', '13px');
        root.style.setProperty('--cp-safe-area-right', '19px');
        root.style.setProperty('--cp-safe-area-bottom', '21px');
        root.style.setProperty('--cp-safe-area-left', '23px');
    });
    const values = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="viewport"]')?.content || '';
        const layout = document.getElementById('mobileLayout');
        const viewToggle = document.getElementById('mobileViewToggle');
        const settings = document.getElementById('mobileSettingsBtn');
        const controls = document.getElementById('mobileBottomControls');
        const sheet = document.getElementById('mobilePlaylistSheet');
        return {
            meta,
            layoutPaddingTop: getComputedStyle(layout).paddingTop,
            viewToggleLeft: getComputedStyle(viewToggle).left,
            settingsRight: getComputedStyle(settings).right,
            controlsPaddingLeft: getComputedStyle(controls).paddingLeft,
            controlsPaddingRight: getComputedStyle(controls).paddingRight,
            controlsPaddingBottom: getComputedStyle(controls).paddingBottom,
            sheetPaddingLeft: getComputedStyle(sheet).paddingLeft,
            sheetPaddingRight: getComputedStyle(sheet).paddingRight,
            sheetPaddingBottom: getComputedStyle(sheet).paddingBottom
        };
    });
    expect(values.meta).toContain('viewport-fit=cover');
    expect(values.layoutPaddingTop).toBe('13px');
    expect(values.viewToggleLeft).toBe('23px');
    expect(values.settingsRight).toBe('19px');
    expect(values.controlsPaddingLeft).toBe('23px');
    expect(values.controlsPaddingRight).toBe('19px');
    expect(values.controlsPaddingBottom).toBe('21px');
    expect(values.sheetPaddingLeft).toBe('23px');
    expect(values.sheetPaddingRight).toBe('19px');
    expect(values.sheetPaddingBottom).toBe('21px');
});
