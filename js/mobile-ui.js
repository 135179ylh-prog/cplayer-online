// Mobile layout controller, extracted from js/app.js.
// It builds its own DOM cache and owns no shared application state: the media
// element, the player state accessors and the actions it triggers are injected
// by the caller.
import { classifyPlaybackFailure } from './core-utils.js';

export class MobileUIManager {
    constructor(deps = {}) {
        // Everything this class used to read from module scope arrives here, so
        // the module owns no player state of its own.
        this.deps = deps;
        this.isMobile = this.deps.isMobileLayoutViewport();
        this.currentMode = 'cover';
        this.activeSheetTab = 'playlist'; // playlist | search
        this.searchRequestId = 0;
        this.pendingSearchQuery = '';

        this.dom = {
            mobileLayout: document.getElementById('mobileLayout'),
            // Main Views
            mobileCoverContainer: document.getElementById('mobileCoverContainer'),
            mobileLyricsContainer: document.getElementById('mobileLyricsPage'),

            // Sheet
            sheet: document.getElementById('mobilePlaylistSheet'),
            sheetToggleBtn: document.getElementById('mobilePlaylistToggleBtn'),
            closeSheetBtn: document.getElementById('closeSheetBtn'),

            // Sheet Tabs
            tabPlaylist: document.getElementById('sheetTabPlaylist'),
            tabSearch: document.getElementById('sheetTabSearch'),

            // Sheet Content
            contentPlaylist: document.getElementById('sheetContentPlaylist'),
            contentSearch: document.getElementById('sheetContentSearch'),
            playlistContainer: document.getElementById('mobilePlaylistContainer'),
            searchResults: document.getElementById('mobileSearchResults'),
            searchInput: document.getElementById('mobileSearchInput'),

            // Elements
            vinyl: document.getElementById('mobileAlbumArtWrapper'),
            vinylContainer: document.getElementById('mobileVinylContainer'),
            coverImg: document.getElementById('mobileCoverImg'),
            title: document.getElementById('mobileTitle'),
            artist: document.getElementById('mobileArtist'),
            // Metadata
            sourceTag: document.getElementById('mobileSourceTag'),
            songIdTag: document.getElementById('mobileSongIdTag'),
            qualityBadge: document.getElementById('mobileQualityBadge'),

            // Controls
            playBtn: document.getElementById('mobilePlayBtn'),
            viewToggle: document.getElementById('mobileViewToggle'),
            progressBar: document.getElementById('mobileProgressBar'),
            progressContainer: document.getElementById('mobileProgressBarContainer'),
            currentTime: document.getElementById('mobileCurrentTime'),
            duration: document.getElementById('mobileDuration'),
            prevBtn: document.getElementById('mobilePrevBtn'),
            nextBtn: document.getElementById('mobileNextBtn'),
            modeBtn: document.getElementById('mobileModeBtn')
        };

        this.init();
    }

    init() {
        this.bindEvents();
        this.bindSheetEvents();
        this.switchSheetTab(this.activeSheetTab);
        // 延迟执行 initial resize 以确保 DOM就绪
        requestAnimationFrame(() => this.handleResize());
        window.addEventListener('resize', () => this.handleResize());

                this.loadPlaylist();
                setTimeout(() => {
                    const activeItem = document.getElementById('mobile-playing-item');
            if (activeItem) activeItem.scrollIntoView({ block: 'center', behavior: 'auto' });
                }, 500);
    }

    bindEvents() {
        this.dom.viewToggle?.addEventListener('click', () => this.toggleView());

        // Swipe Logic
        let touchStartX = 0;
        let touchEndX = 0;

        const handleSwipe = () => {
            const SWIPE_THRESHOLD = 50;
            if (touchEndX < touchStartX - SWIPE_THRESHOLD) {
                // Swipe Left -> Show Lyrics
                if (this.currentMode === 'cover') this.toggleView();
            }
            if (touchEndX > touchStartX + SWIPE_THRESHOLD) {
                // Swipe Right -> Show Cover
                if (this.currentMode === 'lyrics') this.toggleView();
            }
        };

        const mainView = document.getElementById('mobileMainView');
        mainView?.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });
        mainView?.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            handleSwipe();
        });

        // Click Vinyl to Toggle View (ONLY if sheet is closed)
        this.dom.vinylContainer?.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent bubbling
            if (!this.dom.sheet.classList.contains('translate-y-0')) {
                this.toggleView();
            } else {
                // If sheet is open, close it (handled by document click, but just in case)
                this.closeSheet();
            }
        });

        // Global Click to Close Sheet
        document.addEventListener('click', (e) => {
            const sheet = this.dom.sheet;
            const toggleBtn = this.dom.sheetToggleBtn;

            // If sheet is open (translate-y-0)
            if (sheet.classList.contains('translate-y-0')) {
                // If click is OUTSIDE sheet and NOT on toggle button
                if (!sheet.contains(e.target) && (!toggleBtn || !toggleBtn.contains(e.target)) &&
                    !this.deps.isOverlayInteractionTarget(e.target)) {
                    this.closeSheet();
                }
            }
        });

        // Sync Controls
        this.dom.playBtn?.addEventListener('click', this.deps.togglePlayPause);
        this.dom.prevBtn?.addEventListener('click', this.deps.playPreviousSong);
        this.dom.nextBtn?.addEventListener('click', this.deps.playNextSong);
        this.dom.modeBtn?.addEventListener('click', () => this.deps.cyclePlayMode());

        // Progress
        this.dom.progressContainer?.addEventListener('click', (e) => {
            const rect = this.dom.progressContainer.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (this.deps.audio.duration) {
                this.deps.audio.currentTime = percent * this.deps.audio.duration;
                // Pre-existing defect preserved: js/app.js never defined a
                // top-level updateProgress, so this line already threw before the
                // extraction and the click handler stopped here. Kept as an
                // injected call so the failure stays in the same place; fixing it
                // belongs in its own change, not in a move that must not alter
                // behaviour.
                this.deps.updateProgress();
            }
        });
        this.dom.progressContainer?.addEventListener('keydown', this.deps.handleProgressKeydown);
    }

    bindSheetEvents() {
        // Toggle Sheet
        this.dom.sheetToggleBtn?.addEventListener('click', () => this.openSheet());
        this.dom.closeSheetBtn?.addEventListener('click', () => this.closeSheet(true));

        // Switch Tabs
        this.dom.tabPlaylist?.addEventListener('click', () => this.switchSheetTab('playlist'));
        this.dom.tabSearch?.addEventListener('click', () => this.switchSheetTab('search'));
        this.deps.bindArrowTabNavigation(this.dom.tabPlaylist && this.dom.tabPlaylist.parentElement,
            [this.dom.tabPlaylist, this.dom.tabSearch], (tab) => {
                this.switchSheetTab(tab === this.dom.tabSearch ? 'search' : 'playlist');
            });

        // Search Input
        this.dom.searchInput?.addEventListener('change', (e) => {
            this.submitSearch(e.target.value);
        });
        this.dom.searchInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.submitSearch(e.target.value);
        });

        // ★ 拖拽关闭手势
        this.bindSheetDrag();
    }

    bindSheetDrag() {
        const sheet = this.dom.sheet;
        const handle = document.getElementById('sheetDragHandle');
        if (!sheet || !handle) return;

        let startY = 0;
        let currentTranslateY = 0;
        let isDragging = false;

        const onTouchStart = (e) => {
            isDragging = true;
            startY = e.touches[0].clientY;
            currentTranslateY = 0;
            sheet.style.transition = 'none'; // 拖拽时禁用过渡
        };

        const onTouchMove = (e) => {
            if (!isDragging) return;
            const deltaY = e.touches[0].clientY - startY;
            if (deltaY > 0) { // 只允许下拉
                currentTranslateY = deltaY;
                sheet.style.transform = `translateY(${deltaY}px)`;
            }
        };

        const onTouchEnd = () => {
            if (!isDragging) return;
            isDragging = false;
            sheet.style.transition = ''; // 恢复过渡
            sheet.style.transform = ''; // 清除内联 transform

            const THRESHOLD = 100; // 下拉超过100px则关闭
            if (currentTranslateY > THRESHOLD) {
                this.closeSheet();
            } else {
                // 弹回
                this.openSheet();
            }
            currentTranslateY = 0;
        };

        // 在手柄和整个 sheet 顶部区域监听
        handle.addEventListener('touchstart', onTouchStart, { passive: true });
        handle.addEventListener('touchmove', onTouchMove, { passive: true });
        handle.addEventListener('touchend', onTouchEnd);

        // 也允许从 sheet 头部拖拽
        const tabArea = sheet.querySelector('.flex-none');
        if (tabArea) {
            tabArea.addEventListener('touchstart', onTouchStart, { passive: true });
            tabArea.addEventListener('touchmove', onTouchMove, { passive: true });
            tabArea.addEventListener('touchend', onTouchEnd);
        }
    }

    // Sheet Logic
    openSheet() {
        // ★ Fix: 打开前刷新播放列表，确保显示最新状态
        this.loadPlaylist();
        this.dom.sheet.classList.remove('translate-y-[110%]');
        this.dom.sheet.classList.add('translate-y-0');
        this.dom.sheet.inert = false;
        this.dom.sheet.setAttribute('aria-hidden', 'false');
        this.dom.sheetToggleBtn?.setAttribute('aria-expanded', 'true');
        const activeTab = this.activeSheetTab === 'search' ? this.dom.tabSearch : this.dom.tabPlaylist;
        requestAnimationFrame(() => activeTab?.focus());
    }

    closeSheet(restoreFocus) {
        const focusWasInside = this.dom.sheet.contains(document.activeElement);
        this.dom.sheet.style.transform = ''; // 清除拖拽残留
        this.dom.sheet.classList.remove('translate-y-0');
        this.dom.sheet.classList.add('translate-y-[110%]');
        this.dom.sheet.setAttribute('aria-hidden', 'true');
        this.dom.sheet.inert = true;
        this.dom.sheetToggleBtn?.setAttribute('aria-expanded', 'false');
        if ((restoreFocus || focusWasInside) && this.dom.sheetToggleBtn) {
            requestAnimationFrame(() => this.dom.sheetToggleBtn.focus());
        }
    }

    switchSheetTab(tab) {
        this.activeSheetTab = tab;
        const isPlaylist = tab === 'playlist';

        // Update Tab Styles
        this.dom.tabPlaylist.classList.toggle('opacity-100', isPlaylist);
        this.dom.tabPlaylist.classList.toggle('opacity-50', !isPlaylist);
        this.dom.tabPlaylist.classList.toggle('border-primary-color', isPlaylist);
        this.dom.tabPlaylist.classList.toggle('border-transparent', !isPlaylist);

        this.dom.tabSearch.classList.toggle('opacity-100', !isPlaylist);
        this.dom.tabSearch.classList.toggle('opacity-50', isPlaylist);
        this.dom.tabSearch.classList.toggle('border-primary-color', !isPlaylist);
        this.dom.tabSearch.classList.toggle('border-transparent', isPlaylist);

        // Update Content Visibility
        this.dom.contentPlaylist.classList.toggle('hidden', !isPlaylist);
        this.dom.contentSearch.classList.toggle('hidden', isPlaylist);
        this.dom.contentSearch.classList.toggle('flex', !isPlaylist);
        this.deps.setAccessibleTabState(this.dom.tabPlaylist, this.dom.contentPlaylist, isPlaylist);
        this.deps.setAccessibleTabState(this.dom.tabSearch, this.dom.contentSearch, !isPlaylist);
    }

    // Data Logic
    loadPlaylist() { // Virtual scroll for mobile playlist (diff-based)
        try {
            if (!window.playlist || !Array.isArray(window.playlist)) return;

            const container = this.dom.playlistContainer;
            const scrollParent = container.parentElement; // sheetContentPlaylist

            let displayOrder = [];
            if (this.deps.getPlayMode() === 'shuffle' && this.deps.getShuffledOrder().length === window.playlist.length) {
                displayOrder = this.deps.getShuffledOrder();
            } else {
                displayOrder = window.playlist.map((_, i) => i);
            }

            const MH = 64;  // item height, stable with 44px actions
            const MB = 20;  // buffer
            const totalHeight = displayOrder.length * MH;

            container.innerHTML = '';
            container.style.height = totalHeight + 'px';
            container.style.position = 'relative';
            container.classList.remove('pb-20');

            let mRange = { start: -1, end: -1 };
            let mRAF = null;
            let mNodes = new Map(); // displayIndex -> DOM node
            const self = this;

            const mCreateItem = (i) => {
                const actualIndex = displayOrder[i];
                const song = window.playlist[actualIndex];
                const isPlaying = actualIndex === this.deps.getCurrentIndex();
                const textClass = isPlaying ? 'text-primary-color' : 'text-white/90';
                const coverSrc = song.cover || '';

                const div = document.createElement('div');
                div.className = `flex items-center gap-2 px-3 rounded-xl border-b border-white/5 ${isPlaying ? 'bg-white/10' : ''}`;
                div.style.cssText = `position:absolute;top:${i * MH}px;left:0;right:0;height:${MH}px;display:flex;align-items:center;`;
                div.dataset.mvsIdx = i;
                if (isPlaying) div.id = 'mobile-playing-item';

                div.innerHTML = `
                    <button type="button" class="js-play-queue flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg" aria-label="播放「${this.deps.escapeHtml(song.name || '未知歌曲')}」">
                        <span class="text-xs font-mono opacity-50 w-6 text-center flex-none">${i + 1}</span>
                        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40" decoding="async" alt="" class="w-10 h-10 rounded-lg object-cover bg-white/5 flex-none" loading="lazy" crossorigin="anonymous">
                        <span class="flex-1 min-w-0">
                            <span class="block font-bold truncate text-sm ${textClass}">${this.deps.escapeHtml(song.name || '未知歌曲')}</span>
                            <span class="block text-xs truncate opacity-50">${this.deps.escapeHtml(song.artist || '')}</span>
                        </span>
                    </button>
                    <button type="button" class="js-add-playlist-item flex-none w-14 h-11 rounded-full border border-white/25 flex items-center justify-center gap-1 text-white/85 text-xs active:bg-white/10" title="收藏到歌单" aria-label="收藏到歌单" style="pointer-events:auto;z-index:5;position:relative;">
                        <i class="fas fa-folder-plus" aria-hidden="true"></i><span>歌单</span>
                    </button>
                    <button type="button" class="js-remove-queue flex-none w-14 h-11 rounded-full border border-white/25 flex items-center justify-center text-white/85 text-xs active:bg-red-500/40" title="从播放列表移除" aria-label="从播放列表移除" style="pointer-events:auto;z-index:5;position:relative;">
                        移除
                    </button>
                `;
                const playButton = div.querySelector('.js-play-queue');
                const addPlaylistBtn = div.querySelector('.js-add-playlist-item');
                if (addPlaylistBtn) {
                    addPlaylistBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.openAddToPlaylistModal(song);
                    };
                }
                const removeBtn = div.querySelector('.js-remove-queue');
                if (removeBtn) {
                    removeBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof window.removeSongFromQueue === 'function') {
                            window.removeSongFromQueue(actualIndex);
                        }
                    };
                }
                if (playButton) {
                    playButton.onclick = () => {
                        this.deps.playSongAtIndex(actualIndex);
                        self.closeSheet();
                    };
                }

                if (coverSrc) {
                    const img = div.querySelector('.js-play-queue img');
                    window.getCachedImage(`${coverSrc}?param=80y80`).then(cachedSrc => {
                        if (img.isConnected) img.src = cachedSrc;
                    });
                }
                return div;
            };

            const mRender = (force) => {
                const st = scrollParent.scrollTop;
                const vh = scrollParent.clientHeight;

                let s = Math.max(0, Math.floor(st / MH) - MB);
                let e = Math.min(displayOrder.length, Math.ceil((st + vh) / MH) + MB);

                if (!force && s === mRange.start && e === mRange.end) return;

                if (force) {
                    container.innerHTML = '';
                    mNodes.clear();
                    const frag = document.createDocumentFragment();
                    for (let i = s; i < e; i++) {
                        const node = mCreateItem(i);
                        mNodes.set(i, node);
                        frag.appendChild(node);
                    }
                    container.appendChild(frag);
                } else {
                    // 移除离开范围的
                    for (let i = mRange.start; i < mRange.end; i++) {
                        if (i < s || i >= e) {
                            const node = mNodes.get(i);
                            if (node && node.parentNode) node.parentNode.removeChild(node);
                            mNodes.delete(i);
                        }
                    }
                    // 添加新进入范围的
                    const frag = document.createDocumentFragment();
                    let added = false;
                    for (let i = s; i < e; i++) {
                        if (!mNodes.has(i)) {
                            const node = mCreateItem(i);
                            mNodes.set(i, node);
                            frag.appendChild(node);
                            added = true;
                        }
                    }
                    if (added) container.appendChild(frag);
                }
                mRange = { start: s, end: e };
            };

            mRender(true);

            scrollParent.onscroll = () => {
                if (mRAF) return;
                mRAF = requestAnimationFrame(() => {
                    mRAF = null;
                    mRender(false);
                });
            };

            // 自动滚动到当前播放
            const playingPos = displayOrder.indexOf(this.deps.getCurrentIndex());
            if (playingPos !== -1) {
                requestAnimationFrame(() => {
                    const targetTop = playingPos * MH - scrollParent.clientHeight / 2 + MH / 2;
                    scrollParent.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
                });
            }
        } catch (e) {
            console.error('Failed to load playlist', e);
            this.dom.playlistContainer.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">加载失败</div>';
        }
    }

    submitSearch(query) {
        const normalizedQuery = String(query || '').trim();
        if (normalizedQuery && this.pendingSearchQuery === normalizedQuery) return;
        this.pendingSearchQuery = normalizedQuery;
        Promise.resolve(this.handleSearch(normalizedQuery)).finally(() => {
            if (this.pendingSearchQuery === normalizedQuery) this.pendingSearchQuery = '';
        });
    }
    async handleSearch(query) {
        query = String(query || '').trim();
        const requestId = ++this.searchRequestId;
        this.deps.cleanupSearchResultPager(this.dom.searchResults);
        if (!query) {
            this.dom.searchResults.innerHTML = '';
            return;
        }

        // [紧急Fix] 纯数字ID直接添加并播放
        if (/^\d+$/.test(query.trim())) {
            const container = this.dom.searchResults;
            container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">正在加载ID歌曲...</div>';

            try {
                const songData = await this.deps.musicService.getSong(query);
                if (requestId !== this.searchRequestId) return;
                if (songData && songData.url) {
                    const newSong = {
                        id: songData.id,
                        name: songData.name,
                        artist: songData.artist,
                        cover: songData.cover,
                        album: songData.album || '',
                        source: 'id_search'
                    };

                    // 插入到播放列表
                    // 直接访问 module scope 的变量
                    const targetIndex = window.insertSongToPlaylist(newSong);

                    // 刷新所有 UI
                    if (typeof this.deps.renderAllPlaylistItems === 'function') this.deps.renderAllPlaylistItems();
                    this.loadPlaylist();

                    // 播放
                    window.playSongAtIndex(targetIndex);

                    this.closeSheet();
                    this.deps.showToast(`已添加并播放: ${newSong.name}`);
                    if (this.dom.searchInput) this.dom.searchInput.value = '';
                } else {
                    container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">无效的ID</div>';
                }
            } catch (e) {
                if (requestId !== this.searchRequestId) return;
                console.error(e);
                const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
                if (failure.kind === 'auth') {
                    this.deps.renderSearchRecoveryState(container, {
                        query: query,
                        error: e,
                        compact: true,
                        onRetry: (retryQuery) => this.submitSearch(retryQuery)
                    });
                } else {
                    container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">加载失败</div>';
                }
            }
            return;
        }

        const container = this.dom.searchResults;
        container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">搜索中...</div>';

        const appendSongs = (songs) => {
            songs.forEach(song => {
                const div = document.createElement('div');
                div.className = 'flex items-center gap-2 p-2 rounded-xl active:bg-white/5 transition-colors';

                div.innerHTML = `
                    <button type="button" class="js-play-search flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg" aria-label="添加并播放「${this.deps.escapeHtml(song.name || '未知歌曲')}」">
                        <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCI+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iIzMzMyIvPjwvc3ZnPg==" width="40" height="40" decoding="async" alt="" class="w-10 h-10 rounded-lg object-cover bg-white/5 flex-none shadow-md" loading="lazy" crossorigin="anonymous">
                        <span class="flex-1 min-w-0">
                            <span class="block font-bold truncate text-sm text-white/90">${this.deps.escapeHtml(song.name || '未知歌曲')}</span>
                            <span class="block text-xs truncate opacity-50">${this.deps.escapeHtml(song.artist || '')}</span>
                        </span>
                    </button>
                    <button type="button" class="js-add-queue p-2 w-12 h-11 gap-1 flex items-center justify-center rounded-full border border-white/20 text-xs" title="加入播放列表（不立即播放）" aria-label="加入播放列表（不立即播放）">
                        <i class="fas fa-plus" aria-hidden="true"></i><span>加入</span>
                    </button>
                    <button type="button" class="js-add-playlist p-2 w-14 h-11 gap-1 flex items-center justify-center rounded-full border border-white/20 text-xs" title="收藏到歌单" aria-label="收藏到歌单">
                        <i class="fas fa-folder-plus" aria-hidden="true"></i><span>歌单</span>
                    </button>
                `;

                if (song.cover) {
                    const image = div.querySelector('.js-play-search img');
                    window.getCachedImage(`${song.cover}?param=80y80`).then(cachedSrc => {
                        if (image && image.isConnected) image.src = cachedSrc;
                    });
                }

                const newSong = {
                    id: song.id, name: song.name, artist: song.artist,
                    cover: song.cover, album: song.album, source: 'netease'
                };
                try {
                    const payload = JSON.stringify(newSong);
                    const aq = div.querySelector('.js-add-queue');
                    const ap = div.querySelector('.js-add-playlist');
                    if (aq) aq.dataset.song = payload;
                    if (ap) ap.dataset.song = payload;
                    if (aq) aq.onclick = (e) => {
                        e.preventDefault(); e.stopPropagation();
                        window.addSongToQueueOnly(newSong);
                        if (typeof this.deps.renderAllPlaylistItems === 'function') this.deps.renderAllPlaylistItems();
                        this.loadPlaylist();
                    };
                    if (ap) ap.onclick = function (e) {
                        e.preventDefault(); e.stopPropagation();
                        window.openAddToPlaylistModal(newSong);
                    };
                } catch (e) {}
                const playButton = div.querySelector('.js-play-search');
                playButton.onclick = () => {
                    const targetIndex = window.insertSongToPlaylist(newSong);
                    if (typeof this.deps.renderAllPlaylistItems === 'function') this.deps.renderAllPlaylistItems();
                    this.loadPlaylist();
                    if (typeof window.playSongAtIndex === 'function') window.playSongAtIndex(targetIndex);
                    this.closeSheet();
                    this.deps.showToast('已添加并播放: ' + song.name);
                };
                container.appendChild(div);
            });
        };

        container.innerHTML = '';
        container.classList.remove('hidden');
        const pager = this.deps.createSearchResultPager({
            query,
            container,
            compact: true,
            isCurrent: () => requestId === this.searchRequestId,
            appendSongs,
            renderEmpty: () => {
                container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">无结果</div>';
            },
            renderInitialError: (error) => {
                console.error('Search failed', error);
                this.deps.renderSearchRecoveryState(container, {
                    query,
                    error,
                    compact: true,
                    onRetry: (retryQuery) => this.submitSearch(retryQuery)
                });
            }
        });
        await pager.loadNext();
    }

    handleResize() {
        const isNowMobile = this.deps.isMobileLayoutViewport();
        if (this.isMobile !== isNowMobile) {
            this.isMobile = isNowMobile;
            if (!this.isMobile) {
                this.closeSheet();
            }
        }
    }

    // View Toggles
    toggleView() {
        this.currentMode = this.currentMode === 'cover' ? 'lyrics' : 'cover';

        if (this.currentMode === 'cover') {
            // Show Cover
            this.dom.mobileCoverContainer.classList.remove('opacity-0', 'pointer-events-none', 'translate-x-[-100%]');
            this.dom.mobileCoverContainer.classList.add('opacity-100', 'translate-x-0');

            // Hide Lyrics
            this.dom.mobileLyricsContainer.classList.add('opacity-0', 'pointer-events-none', 'translate-x-full');
            this.dom.mobileLyricsContainer.classList.remove('opacity-100', 'translate-x-0');
        } else {
            // Hide Cover
            this.dom.mobileCoverContainer.classList.add('opacity-0', 'pointer-events-none', 'translate-x-[-100%]');
            this.dom.mobileCoverContainer.classList.remove('opacity-100', 'translate-x-0');

            // Show Lyrics
            this.dom.mobileLyricsContainer.classList.remove('opacity-0', 'pointer-events-none', 'translate-x-full');
            this.dom.mobileLyricsContainer.classList.add('opacity-100', 'translate-x-0');
        }
        const showingLyrics = this.currentMode === 'lyrics';
        this.dom.mobileCoverContainer.setAttribute('aria-hidden', String(showingLyrics));
        this.dom.mobileCoverContainer.inert = showingLyrics;
        this.dom.mobileLyricsContainer.setAttribute('aria-hidden', String(!showingLyrics));
        this.dom.mobileLyricsContainer.inert = !showingLyrics;
        if (this.dom.viewToggle) {
            const label = showingLyrics ? '返回封面' : '查看歌词';
            this.dom.viewToggle.setAttribute('aria-pressed', String(showingLyrics));
            this.dom.viewToggle.setAttribute('aria-label', label);
            this.dom.viewToggle.title = label;
            const icon = this.dom.viewToggle.querySelector('i');
            if (icon) icon.className = showingLyrics ? 'fas fa-compact-disc' : 'fas fa-align-left';
        }
    }

    resetView() {
        if (this.currentMode !== 'cover') this.toggleView();
    }

    // Updates - 带过渡动画
    updateInfo(title, artist, cover) {
        const elements = [this.dom.title, this.dom.artist, this.dom.coverImg].filter(Boolean);

        // 淡出
        elements.forEach(el => el.style.transition = 'opacity 0.2s ease');
        elements.forEach(el => el.style.opacity = '0');

        setTimeout(() => {
            // 更新内容
            if (this.dom.title) this.dom.title.textContent = title;
            if (this.dom.artist) this.dom.artist.textContent = artist;
            if (this.dom.coverImg) this.dom.coverImg.src = cover;

            // Sync metadata badges from desktop DOM
            const desktopSource = document.getElementById('sourceTag');
            if (this.dom.sourceTag && desktopSource) {
                this.dom.sourceTag.textContent = desktopSource.textContent;
                this.dom.sourceTag.classList.toggle('hidden', desktopSource.classList.contains('hidden'));
            }

            const desktopId = document.getElementById('songIdTag');
            if (this.dom.songIdTag && desktopId) {
                this.dom.songIdTag.textContent = desktopId.textContent;
                this.dom.songIdTag.className = desktopId.className;
            }

            // 淡入
            requestAnimationFrame(() => {
                elements.forEach(el => el.style.opacity = '1');
            });
        }, 200); // 等淡出完成
    }

    updatePlayState(isPlaying) {
        if (this.dom.vinyl) {
            this.dom.vinyl.classList.toggle('playing', isPlaying);
        }
        const icon = this.dom.playBtn?.querySelector('i');
        if (icon) icon.className = isPlaying ? 'fas fa-pause pl-0' : 'fas fa-play pl-1';
    }

    updateProgress(currentTime, duration, progressPercent) {
        if (this.dom.currentTime) this.dom.currentTime.textContent = this.deps.formatTime(currentTime);
        if (this.dom.duration) this.dom.duration.textContent = this.deps.formatTime(duration);
        if (this.dom.progressBar) this.dom.progressBar.style.width = `${progressPercent}%`;
        this.deps.syncProgressAccessibility(this.dom.progressContainer, currentTime, duration);
    }
}
