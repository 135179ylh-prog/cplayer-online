// Desktop virtual-scroll playlist view, extracted from js/app.js.
// The six vs* bindings below are module-private: nothing outside this block
// referenced them. Player state arrives through getters so every read is
// current, since a snapshot would freeze the rows this list renders.

// Set once during startup, before the first render.
let deps = {};
export function configurePlaylistView(next) {
    deps = next;
}

const VS_ITEM_H = 64;       // 每项高度 (px)，容纳 44px 键盘/触控操作
const VS_BUFFER = 30;       // 上下各多渲染30项
let vsDisplayOrder = [];     // 当前显示顺序
let vsRenderedRange = { start: -1, end: -1 };  // 当前已渲染范围
let vsScrollRAF = null;      // 防抖 requestAnimationFrame
let vsNodeMap = new Map();   // displayIndex -> DOM node

function getDisplayOrder() {
    if (deps.getPlayMode() === 'shuffle' && deps.getShuffledOrder().length === deps.getPlaylist().length) {
        return deps.getShuffledOrder();
    }
    return deps.getPlaylist().map((_, i) => i);
}

export function setupVirtualScroll() {
    vsDisplayOrder = getDisplayOrder();
    vsRenderedRange = { start: -1, end: -1 };
    vsNodeMap.clear();

    if (!deps.getPlaylist().length) {
        deps.dom.playlistContent.innerHTML = '<div class="text-center py-8 opacity-50">播放列表为空</div>';
        deps.dom.playlistContent.style.height = '';
        deps.dom.playlistContent.style.position = '';
        return;
    }

    const totalHeight = vsDisplayOrder.length * VS_ITEM_H;
    deps.dom.playlistContent.innerHTML = '';
    deps.dom.playlistContent.style.height = totalHeight + 'px';
    deps.dom.playlistContent.style.position = 'relative';

    vsRenderVisible(true);

    deps.dom.playlistContainer.onscroll = () => {
        if (vsScrollRAF) return;
        vsScrollRAF = requestAnimationFrame(() => {
            vsScrollRAF = null;
            vsRenderVisible(false);
        });
    };
}

function vsCreateItem(i) {
    const actualIndex = vsDisplayOrder[i];
    const song = deps.getPlaylist()[actualIndex];
    const songId = typeof song === 'object' ? song.id : song;
    const songName = typeof song === 'object' ? song.name : `歌曲 ID: ${song}`;
    const songArtist = typeof song === 'object' ? song.artist : '';
    const songCover = typeof song === 'object' ? song.cover : '';

    const div = document.createElement('div');
    div.className = 'deps.getPlaylist()-item p-2 rounded-xl hover:bg-surface-container-high-color flex items-center gap-2 group theme-text-on-surface';
    div.dataset.idx = actualIndex;
    div.dataset.vsIdx = i;
    div.style.cssText = `position:absolute;top:${i * VS_ITEM_H}px;left:0;right:0;height:${VS_ITEM_H}px;`;

    if (actualIndex === deps.getCurrentIndex()) {
        div.classList.add('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');
    }

    const numSpan = document.createElement('span');
    numSpan.className = 'song-index opacity-50 group-hover:opacity-100 font-mono text-xs w-6 text-right flex-shrink-0';
    numSpan.textContent = `${i + 1}`;

    const coverDiv = document.createElement('div');
    coverDiv.className = 'w-10 h-10 rounded-lg bg-surface-container-color flex-shrink-0 overflow-hidden';
    if (songCover) {
        const img = document.createElement('img');
        img.className = 'w-full h-full object-cover';
        img.loading = 'lazy';
        img.width = 40;
        img.height = 40;
        img.decoding = 'async';
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        window.getCachedImage(`${songCover}?param=80y80`).then(cachedSrc => {
            if (img.isConnected) img.src = cachedSrc;
        });
        img.alt = songName;
        img.onerror = () => { img.style.display = 'none'; };
        coverDiv.appendChild(img);
    } else {
        coverDiv.innerHTML = '<i class="fas fa-music text-xs opacity-30 flex items-center justify-center w-full h-full"></i>';
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'flex-1 min-w-0';
    const titleDiv = document.createElement('div');
    titleDiv.className = 'truncate text-sm font-medium';
    titleDiv.textContent = songName;
    const artistDiv = document.createElement('div');
    artistDiv.className = 'truncate text-xs opacity-50';
    artistDiv.textContent = songArtist || '未知艺术家';
    infoDiv.appendChild(titleDiv);
    infoDiv.appendChild(artistDiv);

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg';
    playButton.setAttribute('aria-label', '播放「' + songName + '」');
    playButton.appendChild(numSpan);
    playButton.appendChild(coverDiv);
    playButton.appendChild(infoDiv);
    div.appendChild(playButton);

    playButton.onclick = () => {
        deps.setCurrentIndex(actualIndex);
        deps.loadAndPlaySong(songId, { index: actualIndex, reason: 'playlist_click' });
    };
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'js-remove-queue w-11 h-11 flex-none flex items-center justify-center rounded-full border border-white/15 text-xs opacity-70';
    delBtn.setAttribute('aria-label', '从播放列表移除「' + songName + '」');
    delBtn.title = '从播放列表移除';
    delBtn.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
    delBtn.onclick = function (e) {
        e.stopPropagation();
        window.removeSongFromQueue(actualIndex);
    };
    div.appendChild(delBtn);
    return div;
}

function vsRenderVisible(forceRebuild) {
    const scrollTop = deps.dom.playlistContainer.scrollTop;
    const viewHeight = deps.dom.playlistContainer.clientHeight;
    const totalItems = vsDisplayOrder.length;

    let newStart = Math.floor(scrollTop / VS_ITEM_H) - VS_BUFFER;
    let newEnd = Math.ceil((scrollTop + viewHeight) / VS_ITEM_H) + VS_BUFFER;
    newStart = Math.max(0, newStart);
    newEnd = Math.min(totalItems, newEnd);

    const oldStart = vsRenderedRange.start;
    const oldEnd = vsRenderedRange.end;

    if (!forceRebuild && newStart === oldStart && newEnd === oldEnd) return;

    if (forceRebuild) {
        // 全量初始化
        deps.dom.playlistContent.innerHTML = '';
        vsNodeMap.clear();
        const frag = document.createDocumentFragment();
        for (let i = newStart; i < newEnd; i++) {
            const node = vsCreateItem(i);
            vsNodeMap.set(i, node);
            frag.appendChild(node);
        }
        deps.dom.playlistContent.appendChild(frag);
    } else {
        // 增量：移除离开范围的节点
        for (let i = oldStart; i < oldEnd; i++) {
            if (i < newStart || i >= newEnd) {
                const node = vsNodeMap.get(i);
                if (node && node.parentNode) node.parentNode.removeChild(node);
                vsNodeMap.delete(i);
            }
        }
        // 增量：添加新进入范围的节点
        const frag = document.createDocumentFragment();
        let added = false;
        for (let i = newStart; i < newEnd; i++) {
            if (!vsNodeMap.has(i)) {
                const node = vsCreateItem(i);
                vsNodeMap.set(i, node);
                frag.appendChild(node);
                added = true;
            }
        }
        if (added) deps.dom.playlistContent.appendChild(frag);
    }

    vsRenderedRange = { start: newStart, end: newEnd };
}

// 一次性渲染播放列表（保留作为兼容入口，内部走虚拟滚动）
export function renderAllPlaylistItems() {
    setupVirtualScroll();
}

// 保留旧函数名以兼容
function renderPlaylistChunk() {
    renderAllPlaylistItems();
}

// Expose functions globally for Mobile UI
window.playSongAtIndex = (index, options) => {
    options = options || {};
    if (index < 0 || index >= deps.getPlaylist().length) return;
    const prefetchedMedia = options.prefetchedMedia || deps.takePreloadedNextMedia(index);
    deps.setCurrentIndex(index);
    deps.scheduleSaveCurrentQueue('play_index'); // Sync with global variable
    // currentSongIndex = index; // Removed if not defined

    const song = deps.getPlaylist()[index];
    const songId = typeof song === 'object' ? song.id : song;

    deps.loadAndPlaySong(songId, {
        index: index,
        reason: options.reason || 'play_index',
        resumeTime: options.useSavedResume === false ? 0 : deps.getPlaybackResumeTime(index),
        prefetchedMedia
    });

    // Sync mobile deps.getPlaylist() view if active
    if (deps.getMobileUI() && deps.getMobileUI().activeSheetTab === 'deps.getPlaylist()') {
        deps.getMobileUI().loadPlaylist();
    }
};

export function highlightCurrentSong() {
    // 移除旧的高亮
    const old = deps.dom.playlistContent.querySelector('.playing-item');
    if (old) old.classList.remove('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');

    // 添加新的高亮（如果当前歌曲在可见区域内）
    let el = deps.dom.playlistContent.querySelector(`div[data-idx="${deps.getCurrentIndex()}"]`);
    if (el) {
        el.classList.add('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');
    }

    // 滚动到当前歌曲在显示顺序中的位置
    const displayPos = vsDisplayOrder.indexOf(deps.getCurrentIndex());
    if (displayPos !== -1) {
        const targetTop = displayPos * VS_ITEM_H - deps.dom.playlistContainer.clientHeight / 2 + VS_ITEM_H / 2;
        deps.dom.playlistContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
}
