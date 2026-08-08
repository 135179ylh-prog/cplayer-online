// Desktop search rendering and result paging, extracted from js/app.js.
// The request-id guard that isolates stale responses is module-private state.
// Everything this module needs from the player arrives through configure().
import { SEARCH_PAGE_SIZE, classifyPlaybackFailure, mergeUniqueSearchSongs } from './core-utils.js';

// Set once during startup, before any search can run.
let deps = {};
export function configureSearchView(next) {
    deps = next;
}

let desktopSearchRequestId = 0;

export function renderSearchRecoveryState(container, options) {
    if (!container) return;
    options = options || {};
    const query = String(options.query || '').trim();
    const compact = options.compact === true;
    let message = navigator.onLine === false ? '当前已离线' : '搜索服务暂不可用';
    if (navigator.onLine !== false && options.error) {
        const failure = classifyPlaybackFailure(options.error, true);
        if (failure.kind === 'auth') message = failure.message;
    }
    const state = document.createElement('div');
    state.className = compact
        ? 'p-4 text-center opacity-80 text-xs'
        : 'p-4 text-center text-red-300';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');

    const messageNode = document.createElement('div');
    messageNode.textContent = message;
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = compact
        ? 'mt-3 px-3 py-1.5 rounded-full border border-white/25 text-white/90'
        : 'mt-3 px-4 py-2 rounded-full border border-white/25 text-sm text-white/90 hover:bg-white/10';
    retryButton.setAttribute('aria-label', '重试搜索：' + query);
    retryButton.innerHTML = '<i class="fas fa-redo-alt mr-1" aria-hidden="true"></i><span>重试</span>';
    retryButton.addEventListener('click', function () {
        if (typeof options.onRetry === 'function') options.onRetry(query);
    });

    state.append(messageNode, retryButton);
    container.replaceChildren(state);
}

function renderSearchPaginationControl(container, state, options = {}) {
    if (!container) return;
    const oldControl = container.querySelector('.js-search-pagination');
    if (oldControl) oldControl.remove();
    if (!state.songs.length) return;

    const compact = options.compact === true;
    const control = document.createElement('div');
    control.className = 'js-search-pagination flex flex-col items-center gap-2 px-3 py-3';

    const progress = document.createElement('div');
    progress.className = compact ? 'text-xs opacity-70' : 'text-sm opacity-70';
    progress.setAttribute('role', 'status');
    progress.setAttribute('aria-live', 'polite');
    progress.textContent = state.total === null
        ? `已显示 ${state.songs.length} 首`
        : `已显示 ${state.songs.length} / 共 ${state.total} 首`;
    control.appendChild(progress);

    if (state.error) {
        const error = document.createElement('div');
        error.className = compact ? 'text-xs text-red-300' : 'text-sm text-red-300';
        error.textContent = '加载失败，已保留当前结果';
        control.appendChild(error);
    }

    if (state.hasMore && !state.loading && !state.error) {
        const hint = document.createElement('div');
        hint.className = compact ? 'text-[11px] opacity-50' : 'text-xs opacity-50';
        hint.textContent = '继续下滑会自动加载下一页';
        control.appendChild(hint);
    }

    if (state.hasMore) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = compact
            ? 'min-h-[44px] px-5 rounded-full border border-white/25 text-sm font-medium disabled:opacity-50'
            : 'min-h-[44px] px-6 rounded-full border border-white/25 text-sm font-medium hover:bg-white/10 disabled:opacity-50';
        button.setAttribute('aria-label', '加载更多搜索结果');
        button.disabled = state.loading;
        button.textContent = state.loading ? '加载中…' : (state.error ? '重试加载' : '加载更多');
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            if (typeof options.onLoadMore === 'function') options.onLoadMore();
        });
        control.appendChild(button);
    }

    container.appendChild(control);
}

const SEARCH_AUTO_LOAD_THRESHOLD_PX = 240;
const searchPagerCleanups = new WeakMap();

export function cleanupSearchResultPager(container) {
    const cleanup = searchPagerCleanups.get(container);
    if (typeof cleanup === 'function') cleanup();
}

export function createSearchResultPager(options) {
    const container = options.container;
    cleanupSearchResultPager(container);

    const state = {
        query: options.query,
        songs: [],
        nextOffset: 0,
        total: null,
        hasMore: true,
        loading: false,
        error: false
    };
    let autoLoadFrame = 0;
    let userScrollIntent = false;

    const loadWhenNearBottom = function () {
        if (options.autoLoad === false || state.loading || state.error || !state.hasMore || !options.isCurrent()) return;
        const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (remaining <= SEARCH_AUTO_LOAD_THRESHOLD_PX) loadNext();
    };

    const scheduleAutoLoad = function () {
        if (options.autoLoad === false || autoLoadFrame) return;
        autoLoadFrame = requestAnimationFrame(function () {
            autoLoadFrame = 0;
            loadWhenNearBottom();
        });
    };

    const onScroll = function () {
        if (!userScrollIntent) return;
        scheduleAutoLoad();
    };
    const markUserScrollIntent = function () {
        userScrollIntent = true;
        scheduleAutoLoad();
    };
    const onPointerDown = function (event) {
        if (event.target.closest('button, a, input, [role="button"]')) return;
        markUserScrollIntent();
    };
    const onPointerMove = function (event) {
        if (event.pointerType === 'touch' || event.buttons > 0) markUserScrollIntent();
    };
    const onKeyDown = function (event) {
        if (event.target.closest('button, a, input, [role="button"]')) return;
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
            markUserScrollIntent();
        }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', markUserScrollIntent, { passive: true });
    container.addEventListener('touchmove', markUserScrollIntent, { passive: true });
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove, { passive: true });
    container.addEventListener('keydown', onKeyDown);
    const cleanup = function () {
        container.removeEventListener('scroll', onScroll);
        container.removeEventListener('wheel', markUserScrollIntent);
        container.removeEventListener('touchmove', markUserScrollIntent);
        container.removeEventListener('pointerdown', onPointerDown);
        container.removeEventListener('pointermove', onPointerMove);
        container.removeEventListener('keydown', onKeyDown);
        if (autoLoadFrame) cancelAnimationFrame(autoLoadFrame);
        autoLoadFrame = 0;
        if (searchPagerCleanups.get(container) === cleanup) searchPagerCleanups.delete(container);
    };
    searchPagerCleanups.set(container, cleanup);

    const renderControl = function () {
        renderSearchPaginationControl(container, state, {
            compact: options.compact,
            onLoadMore: loadNext
        });
        if (userScrollIntent) scheduleAutoLoad();
    };

    async function loadNext() {
        if (state.loading || !state.hasMore || !options.isCurrent()) return;
        const previousHasMore = state.hasMore;
        const previousOffset = state.nextOffset;
        state.loading = true;
        state.error = false;
        renderControl();
        try {
            const page = await deps.musicService.searchPage(state.query, {
                limit: SEARCH_PAGE_SIZE,
                offset: state.nextOffset
            });
            if (!options.isCurrent()) return;

            const previousCount = state.songs.length;
            const merged = mergeUniqueSearchSongs(state.songs, page.songs);
            const addedSongs = merged.slice(previousCount);
            state.songs = merged;
            state.nextOffset = page.nextOffset;
            state.total = page.total;
            state.hasMore = page.hasMore && page.nextOffset > previousOffset;
            state.loading = false;

            if (addedSongs.length) options.appendSongs(addedSongs);
            if (!state.songs.length) options.renderEmpty();
            renderControl();
        } catch (error) {
            if (!options.isCurrent()) return;
            state.loading = false;
            state.hasMore = previousHasMore;
            if (!state.songs.length) {
                options.renderInitialError(error);
                return;
            }
            state.error = true;
            renderControl();
        }
    }

    return { state, loadNext, cleanup };
}

export async function searchSongs(query) {
    query = String(query || '').trim();
    const requestId = ++desktopSearchRequestId;
    cleanupSearchResultPager(deps.dom.searchResults);
    if (!query) {
        deps.dom.searchResults.innerHTML = '';
        deps.dom.searchResults.classList.add('hidden');
        return;
    }

    if (/^\d+$/.test(query)) {
        deps.dom.searchResults.innerHTML = Array.from({ length: 1 }).map(() => `
            <div class="playlist-item p-2 rounded-xl flex items-center gap-3 animate-pulse opacity-50 mb-1">
                <div class="w-10 h-10 rounded-lg bg-white/10 flex-shrink-0 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                <div class="flex-1 min-w-0 space-y-2 py-1">
                    <div class="h-4 bg-white/10 rounded w-1/3 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                    <div class="h-3 bg-white/10 rounded w-1/4 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                </div>
            </div>
        `).join('');
        deps.dom.searchResults.classList.remove('hidden');

        try {
            const songData = await deps.musicService.getSong(query);
            if (requestId !== desktopSearchRequestId) return;
            if (songData && songData.url) {
                const newSong = {
                    id: songData.id,
                    name: songData.name,
                    artist: songData.artist,
                    cover: songData.cover,
                    album: songData.album || '',
                    source: 'id_search'
                };

                // 插入到当前播放位置之后
                const targetIndex = window.insertSongToPlaylist(newSong);
                deps.renderAllPlaylistItems();
                deps.playSongAtIndex(targetIndex);
                // Same reasoning as the keyword-result row: keep the result and the
                // query so the next action does not require re-searching.
                deps.showToast(`已添加并播放: ${newSong.name}`);
            } else {
                throw new Error('无效的歌曲ID');
            }
        } catch (e) {
            if (requestId !== desktopSearchRequestId) return;
            console.error(e);
            const failure = classifyPlaybackFailure(e, navigator.onLine !== false);
            if (failure.kind === 'auth') {
                renderSearchRecoveryState(deps.dom.searchResults, {
                    query: query,
                    error: e,
                    onRetry: function (retryQuery) { searchSongs(retryQuery); }
                });
            } else {
                deps.dom.searchResults.innerHTML = '<div class="p-4 text-center text-red-400">无效ID或加载失败</div>';
            }
        }
        return;
    }

    // deps.dom.searchLoader.style.display = 'block';
    deps.dom.searchResults.innerHTML = Array.from({ length: 10 }).map(() => `
        <div class="playlist-item p-2 rounded-xl flex items-center gap-3 animate-pulse opacity-50 mb-1">
            <div class="w-10 h-10 rounded-lg bg-white/10 flex-shrink-0 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
            <div class="flex-1 min-w-0 space-y-2 py-1">
                <div class="h-4 bg-white/10 rounded w-3/4 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                <div class="h-3 bg-white/10 rounded w-1/2 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
            </div>
        </div>
    `).join('');
    deps.dom.searchResults.classList.remove('hidden');

    const appendSongs = function (songs) {
        songs.forEach(song => {
            const div = document.createElement('div');
            div.className = 'playlist-item p-2 rounded-xl hover:bg-surface-container-high-color flex items-center gap-2 transition-all theme-text-on-surface mb-1';

            const coverDiv = document.createElement('span');
            coverDiv.className = 'w-10 h-10 rounded-lg bg-surface-container-color flex-shrink-0 overflow-hidden';
            if (song.cover) {
                const img = document.createElement('img');
                img.className = 'w-full h-full object-cover';
                img.loading = 'lazy';
                img.width = 40;
                img.height = 40;
                img.decoding = 'async';
                img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                window.getCachedImage(`${song.cover}?param=80y80`).then(cachedSrc => {
                    if (img.isConnected) img.src = cachedSrc;
                });
                img.alt = song.name;
                img.onerror = () => { img.style.display = 'none'; };
                coverDiv.appendChild(img);
            } else {
                coverDiv.innerHTML = '<i class="fas fa-music text-xs opacity-30 flex items-center justify-center w-full h-full"></i>';
            }

            const infoDiv = document.createElement('span');
            infoDiv.className = 'flex-1 min-w-0';
            const titleDiv = document.createElement('span');
            titleDiv.className = 'block truncate text-sm font-medium';
            titleDiv.textContent = song.name || '未知歌曲';
            const artistDiv = document.createElement('span');
            artistDiv.className = 'block truncate text-xs opacity-50';
            artistDiv.textContent = song.artist || '未知艺术家';

            infoDiv.appendChild(titleDiv);
            infoDiv.appendChild(artistDiv);

            const playButton = document.createElement('button');
            playButton.type = 'button';
            playButton.className = 'flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg';
            playButton.setAttribute('aria-label', '添加并播放「' + (song.name || '未知歌曲') + '」');
            playButton.appendChild(coverDiv);
            playButton.appendChild(infoDiv);
            div.appendChild(playButton);

            const actions = document.createElement('div');
            actions.className = 'flex items-center gap-1 flex-shrink-0';
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'js-add-queue px-3 h-11 rounded-full border border-white/30 text-xs whitespace-nowrap';
            addBtn.textContent = '加入播放列表';
            addBtn.title = '加入播放列表（不立即播放）';
            addBtn.setAttribute('aria-label', '加入播放列表（不立即播放）');
            const plBtn = document.createElement('button');
            plBtn.type = 'button';
            plBtn.className = 'js-add-playlist px-3 h-11 rounded-full border border-white/30 text-xs whitespace-nowrap';
            plBtn.textContent = '收藏到歌单';
            plBtn.title = '收藏到歌单';
            plBtn.setAttribute('aria-label', '收藏到歌单');
            actions.appendChild(addBtn);
            actions.appendChild(plBtn);
            div.appendChild(actions);
            const newSong = {
                id: song.id, name: song.name, artist: song.artist,
                cover: song.cover, album: song.album || '', source: song.source || 'Search'
            };
            try {
                const payload = JSON.stringify(newSong);
                addBtn.dataset.song = payload;
                plBtn.dataset.song = payload;
            } catch (e) {}
            addBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                window.addSongToQueueOnly(newSong);
                if (typeof deps.renderAllPlaylistItems === 'function') deps.renderAllPlaylistItems();
            };
            plBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                window.openAddToPlaylistModal(newSong);
            };
            playButton.onclick = function () {
                const targetIndex = window.insertSongToPlaylist(newSong);
                deps.renderAllPlaylistItems();
                deps.playSongAtIndex(targetIndex);
                // Keep the results and the query. Clearing them forced a fresh
                // search to add a second song, and neither the add-to-queue button
                // beside this one nor the mobile row behaves that way.
                deps.showToast('已添加并播放: ' + newSong.name);
            };
            deps.dom.searchResults.appendChild(div);
        });
    };

    deps.dom.searchResults.innerHTML = '';
    const pager = createSearchResultPager({
        query,
        container: deps.dom.searchResults,
        isCurrent: () => requestId === desktopSearchRequestId,
        appendSongs,
        renderEmpty: () => {
            deps.dom.searchResults.innerHTML = '<div class="p-4 text-center opacity-60">未找到相关歌曲</div>';
        },
        renderInitialError: (error) => {
            console.error(error);
            renderSearchRecoveryState(deps.dom.searchResults, {
                query,
                error,
                onRetry: function (retryQuery) {
                    if (deps.dom.searchInput) deps.dom.searchInput.value = retryQuery;
                    searchSongs(retryQuery);
                }
            });
        }
    });
    await pager.loadNext();
}
