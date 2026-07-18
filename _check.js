
        // 监听 plusready 事件，增加原生能力支持
        document.addEventListener('plusready', function () {
            // 锁定屏幕方向为竖屏
            plus.screen.lockOrientation("portrait-primary");
            // 设置系统音量控制 (初始化音频模块)
            plus.audio.createPlayer();
            // 申请电源锁 (WakeLock) 防止锁屏断网/断CPU
            plus.device.setWakelock(true);
            // 重写 Android 返回键逻辑
            plus.key.addEventListener("backbutton", function () {
                // 隐藏应用到后台而不是退出
                var main = plus.android.runtimeMainActivity();
                main.moveTaskToBack(false);
            });
        });

        // ================= 架构核心：ChKSz API (整合版) =================

        class ChKSzAPI {
            static get baseUrl() {
                return 'https://api.chksz.top/api';
            }
        }

        class MusicService {
            constructor() {
                this.loadSettings();
                this.baseUrl = 'https://api.chksz.top/api';
            }

            loadSettings() {
                this.config = {
                    quality: localStorage.getItem('cp_quality') || 'jymaster'
                };
            }

            saveSettings(key, value) {
                if (key === 'source') return;
                this.config[key] = value;
                localStorage.setItem(`cp_${key}`, value);
            }

            async search(query) {
                const url = `${this.baseUrl}/163_search?keyword=${encodeURIComponent(query)}&limit=30`;
                try {
                    const res = await fetch(url);
                    const json = await res.json();
                    let items = [];
                    if (json.code === 200) {
                        if (Array.isArray(json.data)) items = json.data;
                        else if (json.data && Array.isArray(json.data.songs)) items = json.data.songs;
                        else if (json.result && Array.isArray(json.result.songs)) items = json.result.songs;
                    }
                    if (items.length > 0) {
                        return items.map(item => ({
                            id: item.id,
                            name: item.name,
                            artist: item.artists ? (Array.isArray(item.artists) ? item.artists.map(a => a.name).join(', ') : (typeof item.artists === 'string' ? item.artists : (item.artists.name || 'Unknown'))) : 'Unknown',
                            album: item.album ? (typeof item.album === 'string' ? item.album : item.album.name) : '',
                            cover: item.picUrl || (item.album ? item.album.picUrl : '') || '',
                            source: 'ChKSz'
                        }));
                    }
                } catch (e) { console.error('Search API Error:', e); }
                return [];
            }

            async getSong(id) {
                const level = (this.config && this.config.quality) ? this.config.quality : 'jymaster';
                const url = `${this.baseUrl}/163_music?id=${id}&level=${level}`;
                const res = await fetch(url);
                const json = await res.json();
                if (json.code === 200 && json.data) {
                    const d = Array.isArray(json.data) ? json.data[0] : json.data;
                    if (d && d.url) {
                        return {
                            id: d.id, url: d.url, name: d.name, artist: d.artist, cover: d.picUrl, source: 'ChKSz', level: d.level || level, br: d.br || d.bitrate
                        };
                    }
                }
                throw new Error('ChKSz GetSong Failed');
            }

            async getLyric(id) {
                const url = `${this.baseUrl}/163_lyric?id=${id}`;
                try {
                    const res = await fetch(url);
                    const json = await res.json();
                    if (json.code === 200 && json.data) {
                        return { lrc: json.data.lrc || '', tlrc: json.data.tlyric || '', yrc: '' };
                    }
                } catch (e) { console.warn('ChKSz Lyric Failed:', e); }
                return null;
            }
        }

        class LyricService {
            static async fetchLyrics(songId) {
                return new MusicService().getLyric(songId);
            }
        }

        // ================= 业务逻辑 =================
        const musicService = new MusicService();

        let audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.volume = 0.5;
        audio.playsInline = true;
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        audio.preload = 'auto';

        // 预加载音频（用于无缝播放）
        let preloadAudio = new Audio();
        preloadAudio.crossOrigin = 'anonymous';
        preloadAudio.volume = 0;
        let preloadedSongId = null;

        let audioContext, analyser, gainNode, isPlaying = false;
        let playlist = [], currentIndex = -1, playMode = 'random';
        let parsedLyrics = [], activeLyricIndex = -1;

        // 伪随机播放：打乱后的播放顺序索引
        let shuffledOrder = [];  // 打乱后的索引顺序
        let shuffledIndex = 0;   // 当前在 shuffledOrder 中的位置

        // ================= IndexedDB 缓存系统 =================
        const DB_NAME = 'CPlayer5DB';
        const DB_VERSION = 3;
        let db = null;

        async function initDatabase() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    db = request.result;
                    resolve(db);
                };

                request.onupgradeneeded = (e) => {
                    const database = e.target.result;

                    // 歌单缓存表
                    if (!database.objectStoreNames.contains('playlists')) {
                        const playlistStore = database.createObjectStore('playlists', { keyPath: 'id' });
                        playlistStore.createIndex('timestamp', 'timestamp');
                    }

                    // 歌词缓存表
                    if (!database.objectStoreNames.contains('lyrics')) {
                        database.createObjectStore('lyrics', { keyPath: 'songId' });
                    }

                    // 图片缓存表
                    if (!database.objectStoreNames.contains('images')) {
                        database.createObjectStore('images', { keyPath: 'url' });
                    }
                };
            });
        }

        // ================= 歌单小图缓存逻辑（仅用于列表缩略图） =================
        window.getCachedImage = async function (url) {
            if (!url || !db) return url;

            // 安全检查：确保 images 表存在
            if (!db.objectStoreNames.contains('images')) {
                return url;
            }

            const secureUrl = url.replace(/^http:/, 'https:');
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction('images', 'readonly');
                    const store = tx.objectStore('images');
                    const req = store.get(secureUrl);
                    req.onsuccess = () => {
                        if (req.result && req.result.data) {
                            resolve(req.result.data); // 命中缓存
                        } else {
                            // 未命中 — 加载图片并缩小到 80x80 存入缓存
                            const img = new Image();
                            img.crossOrigin = 'Anonymous';
                            img.onload = () => {
                                try {
                                    const THUMB_SIZE = 80;
                                    const canvas = document.createElement('canvas');
                                    canvas.width = THUMB_SIZE;
                                    canvas.height = THUMB_SIZE;
                                    const ctx = canvas.getContext('2d');
                                    ctx.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE);
                                    const base64 = canvas.toDataURL('image/jpeg', 0.7);

                                    // 写入缓存
                                    const writeTx = db.transaction('images', 'readwrite');
                                    writeTx.objectStore('images').put({ url: secureUrl, data: base64, timestamp: Date.now() });
                                    resolve(base64);
                                } catch (e) {
                                    resolve(secureUrl); // 降级
                                }
                            };
                            img.onerror = () => resolve(secureUrl);
                            img.src = secureUrl;
                        }
                    };
                    req.onerror = () => resolve(secureUrl);
                } catch (e) {
                    console.warn('Image cache transaction failed:', e);
                    resolve(secureUrl);
                }
            });
        };

        // 保存歌单到 IndexedDB
        async function savePlaylistToCache(playlistId, songs) {
            if (!db) return;
            return new Promise((resolve, reject) => {
                const tx = db.transaction('playlists', 'readwrite');
                const store = tx.objectStore('playlists');
                store.put({
                    id: playlistId,
                    songs: songs,
                    timestamp: Date.now()
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        // 从 IndexedDB 获取歌单
        async function getPlaylistFromCache(playlistId) {
            if (!db) return null;
            return new Promise((resolve, reject) => {
                const tx = db.transaction('playlists', 'readonly');
                const store = tx.objectStore('playlists');
                const request = store.get(playlistId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }

        // ===== Local queue + user playlists (minimal, stable) =====
        const CURRENT_QUEUE_KEY = 'current_queue';
        const USER_PL_PREFIX = 'user_pl_';
        let queueSaveTimer = null;
        let suppressQueueAutosave = false;
        let pendingSongForPlaylist = null;

        function normalizeSongObject(song) {
            if (!song) return null;
            return {
                id: song.id,
                name: song.name || '未知歌曲',
                artist: song.artist || song.artists || '未知艺术家',
                cover: song.cover || song.picUrl || '',
                album: song.album || '',
                source: song.source || 'Search'
            };
        }

        function isSongInPlaylist(songId) {
            return playlist.some(s => String(typeof s === 'object' ? s.id : s) === String(songId));
        }

        async function saveCurrentQueue(reason) {
            if (!db || suppressQueueAutosave) return;
            try {
                const payload = {
                    id: CURRENT_QUEUE_KEY,
                    songs: Array.isArray(playlist) ? playlist.slice() : [],
                    currentIndex: currentIndex,
                    playMode: playMode,
                    timestamp: Date.now(),
                    reason: reason || 'auto'
                };
                const tx = db.transaction('playlists', 'readwrite');
                tx.objectStore('playlists').put(payload);
                await new Promise(function (resolve, reject) {
                    tx.oncomplete = function () { resolve(); };
                    tx.onerror = function () { reject(tx.error); };
                });
                localStorage.setItem('cp_queue_dirty', '1');
            } catch (e) {
                console.warn('[queue] save failed', e);
            }
        }

        function scheduleSaveCurrentQueue(reason) {
            if (queueSaveTimer) clearTimeout(queueSaveTimer);
            queueSaveTimer = setTimeout(function () { saveCurrentQueue(reason); }, 250);
        }

        async function restoreCurrentQueue() {
            if (!db) return false;
            try {
                const cached = await getPlaylistFromCache(CURRENT_QUEUE_KEY);
                if (!cached || !Array.isArray(cached.songs) || !cached.songs.length) return false;
                suppressQueueAutosave = true;
                playlist = cached.songs;
                window.playlist = playlist;
                currentIndex = (typeof cached.currentIndex === 'number' && cached.currentIndex >= 0 && cached.currentIndex < playlist.length) ? cached.currentIndex : -1;
                if (cached.playMode) playMode = cached.playMode;
                playlistTotalCount = playlist.length;
                allSongsLoaded = true;
                playlistSource = 'local_queue';
                playlistSourceName = '本地播放列表';
                if (playMode === 'random' && typeof shufflePlaylist === 'function') shufflePlaylist();
                if (typeof initPlaylistView === 'function') initPlaylistView();
                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                suppressQueueAutosave = false;
                return true;
            } catch (e) {
                suppressQueueAutosave = false;
                console.warn('[queue] restore failed', e);
                return false;
            }
        }

        window.addSongToQueueOnly = function (song, opts) {
            opts = opts || {};
            const newSong = normalizeSongObject(song);
            if (!newSong || newSong.id == null) return -1;
            if (isSongInPlaylist(newSong.id) && !opts.allowDuplicate) {
                if (typeof showToast === 'function') showToast('已在播放列表中: ' + newSong.name);
                return playlist.findIndex(function (s) { return String(typeof s === 'object' ? s.id : s) === String(newSong.id); });
            }
            const idx = window.insertSongToPlaylist(newSong);
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
            scheduleSaveCurrentQueue('add_only');
            if (opts.toast !== false && typeof showToast === 'function') showToast('已加入播放列表: ' + newSong.name);
            return idx;
        };

        window.removeSongFromQueue = function (index, opts) {
            opts = opts || {};
            if (!Array.isArray(playlist) || index < 0 || index >= playlist.length) return false;
            const removed = playlist[index];
            const removedName = typeof removed === 'object' ? (removed.name || '歌曲') : String(removed);
            if (Array.isArray(shuffledOrder) && shuffledOrder.length) {
                const newOrder = [];
                for (let i = 0; i < shuffledOrder.length; i++) {
                    const v = shuffledOrder[i];
                    if (v === index) continue;
                    newOrder.push(v > index ? v - 1 : v);
                }
                shuffledOrder = newOrder;
            }
            playlist.splice(index, 1);
            window.playlist = playlist;
            playlistTotalCount = playlist.length;
            if (playlist.length === 0) {
                currentIndex = -1;
                try { audio.pause(); } catch (e) {}
            } else if (currentIndex === index) {
                if (currentIndex >= playlist.length) currentIndex = playlist.length - 1;
                const next = playlist[currentIndex];
                const nextId = typeof next === 'object' ? next.id : next;
                if (typeof loadAndPlaySong === 'function') loadAndPlaySong(nextId);
            } else if (currentIndex > index) {
                currentIndex -= 1;
            }
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
            scheduleSaveCurrentQueue('remove');
            if (opts.toast !== false && typeof showToast === 'function') showToast('已移除: ' + removedName);
            return true;
        };

        async function listUserPlaylists() {
            if (!db && typeof initDatabase === 'function') {
                try { await initDatabase(); } catch (e) {}
            }
            if (!db) return [];
            return new Promise(function (resolve, reject) {
                try {
                    const tx = db.transaction('playlists', 'readonly');
                    const store = tx.objectStore('playlists');
                    const req = store.getAll ? store.getAll() : null;
                    if (req) {
                        req.onsuccess = function () {
                            const all = req.result || [];
                            resolve(all.filter(function (x) {
                                return x && typeof x.id === 'string' && x.id.indexOf(USER_PL_PREFIX) === 0;
                            }).map(function (x) {
                                return { id: x.id, name: x.name || '未命名歌单', songs: Array.isArray(x.songs) ? x.songs : [], timestamp: x.timestamp || 0 };
                            }).sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); }));
                        };
                        req.onerror = function () { reject(req.error); };
                    } else {
                        resolve([]);
                    }
                } catch (e) { reject(e); }
            });
        }

        async function saveUserPlaylistRecord(rec) {
            if (!db) throw new Error('数据库未就绪');
            const payload = {
                id: rec.id,
                name: rec.name || '未命名歌单',
                songs: Array.isArray(rec.songs) ? rec.songs : [],
                timestamp: Date.now()
            };
            const tx = db.transaction('playlists', 'readwrite');
            tx.objectStore('playlists').put(payload);
            await new Promise(function (resolve, reject) {
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
            return payload;
        }

        async function createUserPlaylist(name) {
            if (!db && typeof initDatabase === 'function') {
                try { await initDatabase(); } catch (e) {}
            }
            if (!db) throw new Error('数据库未就绪');
            const clean = String(name || '').trim() || ('我的歌单 ' + new Date().toLocaleDateString());
            const id = USER_PL_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            return await saveUserPlaylistRecord({ id: id, name: clean, songs: [] });
        }

        async function addSongToUserPlaylist(playlistId, song) {
            const list = await listUserPlaylists();
            const target = list.find(function (p) { return p.id === playlistId; });
            if (!target) throw new Error('歌单不存在');
            const newSong = normalizeSongObject(song);
            if (!target.songs.some(function (s) { return String(s.id) === String(newSong.id); })) {
                target.songs.push(newSong);
            }
            await saveUserPlaylistRecord(target);
            return target;
        }

        async function deleteUserPlaylist(playlistId) {
            if (!db) return;
            const tx = db.transaction('playlists', 'readwrite');
            tx.objectStore('playlists').delete(playlistId);
            await new Promise(function (resolve, reject) {
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        }

        async function loadUserPlaylistIntoQueue(playlistId, autoPlay) {
            const list = await listUserPlaylists();
            const target = list.find(function (p) { return p.id === playlistId; });
            if (!target || !target.songs.length) {
                if (typeof showToast === 'function') showToast('歌单为空', true);
                return;
            }
            suppressQueueAutosave = true;
            playlist = target.songs.map(normalizeSongObject);
            window.playlist = playlist;
            currentIndex = -1;
            playlistTotalCount = playlist.length;
            allSongsLoaded = true;
            playlistSource = 'user_playlist';
            playlistSourceName = target.name;
            if (playMode === 'random' && typeof shufflePlaylist === 'function') shufflePlaylist();
            if (typeof initPlaylistView === 'function') initPlaylistView();
            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
            if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
            suppressQueueAutosave = false;
            scheduleSaveCurrentQueue('load_user_playlist');
            if (typeof showToast === 'function') showToast('已加载歌单: ' + target.name);
            if (autoPlay && playlist.length && typeof window.playSongAtIndex === 'function') window.playSongAtIndex(0);
        }

        function openAddToPlaylistModal(song) {
            try {
                pendingSongForPlaylist = normalizeSongObject(song);
                const modal = document.getElementById('userPlaylistModal');
                if (!modal) {
                    alert('歌单弹窗缺失，请强刷');
                    return;
                }
                modal.classList.remove('hidden');
                modal.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
                refreshUserPlaylistModalList();
            } catch (e) {
                console.error(e);
                alert('打开歌单失败');
            }
        }
        window.openAddToPlaylistModal = openAddToPlaylistModal;

        function closeAddToPlaylistModal() {
            const modal = document.getElementById('userPlaylistModal');
            if (!modal) return;
            modal.style.display = 'none';
            modal.classList.add('hidden');
            pendingSongForPlaylist = null;
        }
        window.closeAddToPlaylistModal = closeAddToPlaylistModal;





        function escapeHtml(str) {
            return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        async function refreshUserPlaylistModalList(statusText) {
            const box = document.getElementById('userPlaylistList');
            if (!box) return;
            if (statusText) {
                const tip = document.createElement('div');
                tip.className = 'p-2 mb-2 text-xs rounded-lg bg-white/10 text-white/80';
                tip.textContent = statusText;
                const existing = box.querySelector('[data-tip="1"]');
                if (existing) existing.remove();
                tip.dataset.tip = '1';
                box.prepend(tip);
            }
            try {
                const list = await listUserPlaylists();
                const rows = list.map(function (pl) {
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'w-full text-left p-3 rounded-xl bg-white/5 mb-2 flex items-center justify-between gap-3';
                    row.innerHTML = '<div class="min-w-0"><div class="font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-xs opacity-50">' + pl.songs.length + ' 首</div></div><span class="text-xs opacity-70">加入</span>';
                    row.onclick = async function () {
                        try {
                            if (!pendingSongForPlaylist) return;
                            const name = pendingSongForPlaylist.name || '歌曲';
                            await addSongToUserPlaylist(pl.id, pendingSongForPlaylist);
                            if (typeof showToast === 'function') showToast('已加入: ' + pl.name + '（' + name + '）');
                            // DO NOT close modal; allow adding same song to more playlists or picking another
                            refreshUserPlaylistModalList('已加入「' + pl.name + '」: ' + name);
                            refreshUserPlaylistLibrary();
                        } catch (e) {
                            console.error(e);
                            if (typeof showToast === 'function') showToast('加入失败', true);
                        }
                    };
                    return row;
                });
                // keep status tip on top
                const tip = box.querySelector('[data-tip="1"]');
                box.innerHTML = '';
                if (tip) box.appendChild(tip);
                if (!list.length) {
                    const empty = document.createElement('div');
                    empty.className = 'p-3 text-sm opacity-50 text-center';
                    empty.textContent = '还没有歌单，先新建一个吧';
                    box.appendChild(empty);
                } else {
                    rows.forEach(function (r) { box.appendChild(r); });
                }
            } catch (e) {
                console.error(e);
                box.innerHTML = '<div class="p-3 text-sm text-red-400">加载失败</div>';
            }
        }

async function refreshUserPlaylistLibrary() {
            const box = document.getElementById('userPlaylistLibrary');
            if (!box) return;
            try {
                const list = await listUserPlaylists();
                if (!list.length) {
                    box.innerHTML = '<div class="text-xs opacity-50 py-2">暂无自建歌单</div>';
                    return;
                }
                box.innerHTML = '';
                list.forEach(function (pl) {
                    const row = document.createElement('div');
                    row.className = 'flex items-center gap-2 p-2 rounded-xl bg-white/5 mb-2';
                    row.innerHTML = '<div class="flex-1 min-w-0"><div class="text-sm font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-[11px] opacity-50">' + pl.songs.length + ' 首</div></div><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="load">播放</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="del">删除</button>';
                    row.querySelector('[data-act="load"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id, true); };
                    row.querySelector('[data-act="del"]').onclick = async function () {
                        if (!confirm('删除歌单「' + pl.name + '」？')) return;
                        await deleteUserPlaylist(pl.id);
                        refreshUserPlaylistLibrary();
                    };
                    box.appendChild(row);
                });
            } catch (e) { console.error(e); }
        }

        function bindUserPlaylistUI() {
            if (window.__userPlaylistUIBound) return;
            window.__userPlaylistUIBound = true;
            document.addEventListener('click', async function (e) {
                const t = e.target;
                if (!t || !t.closest) return;
                if (t.closest('#createUserPlaylistBtn')) {
                    e.preventDefault();
                    try {
                        const nameInput = document.getElementById('newUserPlaylistName');
                        await createUserPlaylist(nameInput ? nameInput.value.trim() : '');
                        if (nameInput) nameInput.value = '';
                        await refreshUserPlaylistLibrary();
                        if (typeof showToast === 'function') showToast('歌单已创建');
                    } catch (err) {
                        console.error(err);
                        if (typeof showToast === 'function') showToast('创建失败', true);
                    }
                    return;
                }
                if (t.closest('#createPlaylistInModalBtn')) {
                    e.preventDefault();
                    try {
                        const modalNameInput = document.getElementById('modalNewPlaylistName');
                        const pl = await createUserPlaylist(modalNameInput ? modalNameInput.value.trim() : '');
                        if (modalNameInput) modalNameInput.value = '';
                        if (pendingSongForPlaylist) {
                            await addSongToUserPlaylist(pl.id, pendingSongForPlaylist);
                            if (typeof showToast === 'function') showToast('已新建并加入: ' + pl.name);
                            closeAddToPlaylistModal();
                        } else if (typeof showToast === 'function') {
                            showToast('歌单已创建');
                        }
                        await refreshUserPlaylistLibrary();
                        await refreshUserPlaylistModalList();
                    } catch (err) {
                        console.error(err);
                        if (typeof showToast === 'function') showToast('创建失败', true);
                    }
                    return;
                }
                if (t.closest('#closeUserPlaylistModal')) {
                    e.preventDefault();
                    closeAddToPlaylistModal();
                    return;
                }
                if (t.closest('#clearQueueBtn')) {
                    e.preventDefault();
                    if (!playlist.length) { if (typeof showToast === 'function') showToast('播放列表已为空'); return; }
                    if (!confirm('清空当前播放列表？')) return;
                    try { audio.pause(); } catch (e) {}
                    playlist = [];
                    window.playlist = playlist;
                    currentIndex = -1;
                    playlistTotalCount = 0;
                    if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                    if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
                    if (typeof scheduleSaveCurrentQueue === 'function') scheduleSaveCurrentQueue('clear');
                    if (typeof showToast === 'function') showToast('已清空播放列表');
                    return;
                }
                if (t.closest('#clearQueueBtn')) {
                    e.preventDefault();
                    if (!playlist.length) { if (typeof showToast === 'function') showToast('播放列表已为空'); return; }
                    if (!confirm('清空当前播放列表？')) return;
                    try { audio.pause(); } catch (e) {}
                    playlist = [];
                    window.playlist = playlist;
                    currentIndex = -1;
                    playlistTotalCount = 0;
                    if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                    if (window.mobileUI && typeof window.mobileUI.loadPlaylist === 'function') window.mobileUI.loadPlaylist();
                    if (typeof scheduleSaveCurrentQueue === 'function') scheduleSaveCurrentQueue('clear');
                    if (typeof showToast === 'function') showToast('已清空播放列表');
                    return;
                }
                if (t.closest('#settingsBtn, #mobileSettingsBtn')) {
                    // leave to original openSettings binding; do not block
                }
            }, true);
            refreshUserPlaylistLibrary();
        }
        window.bindUserPlaylistUI = bindUserPlaylistUI;


        // ================= 伪随机播放：打乱播放列表 =================
        function shufflePlaylist() {
            // Fisher-Yates 洗牌算法
            shuffledOrder = playlist.map((_, i) => i);
            for (let i = shuffledOrder.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffledOrder[i], shuffledOrder[j]] = [shuffledOrder[j], shuffledOrder[i]];
            }
            shuffledIndex = 0;
            console.log('🔀 播放列表已打乱');
        }

        // 获取下一首歌曲的索引
        function getNextSongIndex() {
            if (playMode === 'single') {
                return currentIndex;
            } else if (playMode === 'random') {
                // 伪随机：按照打乱后的顺序播放
                if (shuffledOrder.length !== playlist.length) {
                    shufflePlaylist();
                }
                // 在打乱的顺序中找到当前歌曲的位置，然后返回下一首
                const currentPosInShuffle = shuffledOrder.indexOf(currentIndex);
                const nextPos = (currentPosInShuffle + 1) % shuffledOrder.length;
                return shuffledOrder[nextPos];
            } else {
                // 顺序播放
                return (currentIndex + 1) % playlist.length;
            }
        }

        // 获取上一首歌曲的索引
        function getPreviousSongIndex() {
            if (playMode === 'single') {
                return currentIndex;
            } else if (playMode === 'random') {
                if (shuffledOrder.length !== playlist.length) {
                    shufflePlaylist();
                }
                const currentPosInShuffle = shuffledOrder.indexOf(currentIndex);
                const prevPos = (currentPosInShuffle - 1 + shuffledOrder.length) % shuffledOrder.length;
                return shuffledOrder[prevPos];
            } else {
                return currentIndex <= 0 ? playlist.length - 1 : currentIndex - 1;
            }
        }

        // ================= 无缝播放：预加载下一首 =================
        function preloadNextSong() {
            if (!playlist.length) return;

            const nextIndex = getNextSongIndex();
            const nextSong = playlist[nextIndex];
            const nextSongId = typeof nextSong === 'object' ? nextSong.id : nextSong;

            // 避免重复预加载
            if (preloadedSongId === nextSongId) return;

            // 异步获取下一首歌曲的 URL
            musicService.getSong(nextSongId).then(data => {
                if (data?.url) {
                    preloadAudio.src = data.url;
                    preloadAudio.load();
                    preloadedSongId = nextSongId;
                    console.log('🎵 预加载下一首:', nextSong.name || nextSongId);
                }
            }).catch(() => { });
        }

        // ================= 音质分级识别 =================
        function getQualityBadge(url, bitrate) {
            if (!url) return null;

            // 通过 URL 或 bitrate 判断音质
            const urlLower = url.toLowerCase();

            if (urlLower.includes('flac') || bitrate >= 900000) {
                return { text: 'JyMaster', class: 'quality-lossless', icon: '💎' };
            } else if (urlLower.includes('320') || bitrate >= 320000) {
                return { text: 'Hi-Res', class: 'quality-hires', icon: '✨' };
            } else if (bitrate >= 192000) {
                return { text: 'High', class: 'quality-high', icon: '🎵' };
            } else if (bitrate >= 128000) {
                return { text: 'Standard', class: 'quality-standard', icon: '🎶' };
            }
            return null;
        }

        // ================= 音量标准化 (ReplayGain 模拟) =================
        let compressorNode = null;

        function setupAudioNormalization() {
            // no-op: keep original loudness/timbre
        }

        // ================= 虚拟滚动配置 =================
        let renderedCount = 0;
        const CHUNK_SIZE = 50;  // 每次渲染的数量
        const ITEM_HEIGHT = 56; // 歌单项高度 (px)
        let virtualScrollEnabled = true;

        // 虚拟滚动状态
        let vsState = {
            scrollTop: 0,
            startIndex: 0,
            endIndex: 0,
            itemHeight: 56,  // 每个歌曲项的高度
            bufferCount: 5   // 缓冲区大小
        };

        // ================= 弹簧物理滚动 =================
        let springState = {
            animating: false,
            current: 0,
            target: 0,
            velocity: 0
        };

        // 弹簧参数（参考 aura-music）
        const SPRING_CONFIG = {
            stiffness: 80,    // 更软的弹簧
            damping: 20,      // 适当阻尼
            mass: 1           // 质量
        };

        function springScrollTo(container, targetY) {
            springState.target = targetY;
            springState.current = container.scrollTop;

            if (springState.animating) return;
            springState.animating = true;
            springState.velocity = 0;

            function animate() {
                const { stiffness, damping, mass } = SPRING_CONFIG;

                // 弹簧力 = -k * x
                const displacement = springState.current - springState.target;
                const springForce = -stiffness * displacement;

                // 阻尼力 = -c * v
                const dampingForce = -damping * springState.velocity;

                // 加速度 = F / m
                const acceleration = (springForce + dampingForce) / mass;

                // 更新速度和位置（使用固定时间步长 16ms）
                springState.velocity += acceleration * 0.016;
                springState.current += springState.velocity * 0.016;

                // 应用滚动
                container.scrollTop = springState.current;

                // 判断是否停止（速度和位移都足够小）
                const isSettled = Math.abs(springState.velocity) < 0.5 && Math.abs(displacement) < 0.5;

                if (isSettled) {
                    container.scrollTop = springState.target;
                    springState.animating = false;
                } else {
                    requestAnimationFrame(animate);
                }
            }

            requestAnimationFrame(animate);
        }

        // 主题色系统已移除，使用纯白色/灰色调极简风格
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        let dom = {};

        document.addEventListener('DOMContentLoaded', async () => {
            document.querySelectorAll('[id]').forEach(el => dom[el.id] = el);
            dom.lyricsContainer = document.querySelector('.lyrics-container');
            dom.playlistContainer = document.getElementById('playlistContainer');
            dom.playlistContent = document.getElementById('playlistContent');
            dom.uploadContainer = document.querySelector('.upload-container');
            // dom.playlistInfo = document.querySelector('.playlist-info');
            dom.albumArtWrapper = document.getElementById('albumArtWrapper');
            dom.html = document.documentElement;

            // ★ 初始化 IndexedDB 缓存
            try {
                await initDatabase();
                console.log('💾 IndexedDB 缓存已初始化');
            } catch (e) {
                console.warn('IndexedDB 初始化失败:', e);
            }

            initEventListeners();
            initSettingsUI();
            setupPlaylistIdLoader();
            if (typeof bindUserPlaylistUI === 'function') bindUserPlaylistUI();  // 初始化歌单ID加载按钮
            loadDefaultPlaylist();
            initVisualizer();
            // checkSystemTheme(); // Removed
            // enableGradientModeByDefault(); // Removed

            // [需求4] 检测移动端并显示设置内的按钮
            // initMobileSettingsButtons(); // Removed

            updateVolumeIcon(0.5);

            // ★ MediaSession API (锁屏控制)
            if ('mediaSession' in navigator) {
                const actionHandlers = [
                    ['play', () => audio.play()],
                    ['pause', () => audio.pause()],
                    ['previoustrack', playPreviousSong],
                    ['nexttrack', playNextSong],
                    ['seekto', (details) => {
                        if (details.fastSeek && 'fastSeek' in audio) {
                            audio.fastSeek(details.seekTime);
                            return;
                        }
                        audio.currentTime = details.seekTime;
                        updatePlayerState();
                    }]
                ];

                for (const [action, handler] of actionHandlers) {
                    try {
                        navigator.mediaSession.setActionHandler(action, handler);
                    } catch (error) {
                        console.warn(`The media session action "${action}" is not supported yet.`);
                    }
                }
                console.log('🎛️ MediaSession 已启用 (Enhanced)');
            }

            // ★ PWA Service Worker 注册
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('./sw.js').then(reg => {
                    console.log('📱 Service Worker 已注册');
                }).catch(err => {
                    console.warn('SW 注册失败:', err);
                });
            }

            // H5+ Integration for Android App
            document.addEventListener('plusready', function () {
                // Keep CPU awake
                plus.device.setWakelock(true);

                // Handle physical back button
                plus.key.addEventListener('backbutton', function () {
                    // Move task to background
                    var main = plus.android.runtimeMainActivity();
                    main.moveTaskToBack(false);
                }, false);
            });
        });

        function initEventListeners() {
            dom.searchButton.addEventListener('click', () => searchSongs(dom.searchInput.value));
            dom.searchInput.addEventListener('keypress', (e) => e.key === 'Enter' && searchSongs(dom.searchInput.value));

            // Floating Toggle Button - opens sidebar
            document.getElementById('togglePlaylistBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                togglePlaylistPanel();
            });

            // Desktop Tab Switching
            const desktopTabPlaylist = document.getElementById('desktopTabPlaylist');
            const desktopTabSearch = document.getElementById('desktopTabSearch');
            if (desktopTabPlaylist) {
                desktopTabPlaylist.addEventListener('click', () => switchDesktopTab('playlist'));
            }
            if (desktopTabSearch) {
                desktopTabSearch.addEventListener('click', () => switchDesktopTab('search'));
            }

            dom.playPauseBtn.addEventListener('click', togglePlayPause);
            dom.prevBtn.addEventListener('click', playPreviousSong);
            dom.nextBtn.addEventListener('click', playNextSong);
            dom.playModeBtn.addEventListener('click', togglePlayMode);

            dom.progressBar.parentElement.parentElement.addEventListener('click', seekAudio);

            audio.addEventListener('timeupdate', updatePlayerState);
            audio.addEventListener('play', onPlayStart);
            audio.addEventListener('pause', onPlayPause);
            audio.addEventListener('ended', handleSongEnd);
            audio.addEventListener('loadedmetadata', () => {
                dom.totalTime.textContent = formatTime(audio.duration);
            });

            dom.volumeSlider.addEventListener('input', (e) => {
                audio.volume = e.target.value;
                audio.muted = false;
                updateVolumeIcon(audio.volume);
            });

            dom.volumeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const popover = document.getElementById('volumePopover');
                if (popover.classList.contains('show')) {
                    audio.muted = !audio.muted;
                    updateVolumeIcon(audio.muted ? 0 : audio.volume);
                } else {
                    popover.classList.add('show');
                }
            });

            document.addEventListener('click', (e) => {
                const popover = document.getElementById('volumePopover');
                const btn = document.getElementById('volumeBtn');
                if (popover && !popover.contains(e.target) && !btn.contains(e.target)) {
                    popover.classList.remove('show');
                }

                // Close unified Sidebar
                const playlistPanel = document.getElementById('floatingPlaylistPanel');
                const playlistBtn = document.getElementById('togglePlaylistBtn');
                if (playlistPanel && !playlistPanel.classList.contains('translate-x-full') &&
                    !playlistPanel.contains(e.target) && !playlistBtn.contains(e.target)) {
                    togglePlaylistPanel(false);
                }
            });

            dom.playlistFile.addEventListener('change', handlePlaylistUpload);
            dom.uploadContainer.addEventListener('click', (e) => {
                if (e.target.tagName !== "LABEL") dom.playlistFile.click();
            });
            dom.uploadContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                dom.uploadContainer.style.transform = "scale(1.02)";
            });
            dom.uploadContainer.addEventListener('drop', (e) => {
                e.preventDefault();
                dom.uploadContainer.style.transform = "scale(1)";
                if (e.dataTransfer.files[0]) handlePlaylistFile(e.dataTransfer.files[0]);
            });
            dom.uploadContainer.addEventListener('dragleave', () => {
                dom.uploadContainer.style.transform = "scale(1)";
            });

            // 滚动事件由 setupVirtualScroll 中的 onscroll 处理

            document.getElementById('fullscreenBtn').addEventListener('click', toggleFullScreen);

            // --- Gemini修复: 设置按钮逻辑增强 ---
            const safeSettingsBtn = document.getElementById('settingsBtn');
            if (safeSettingsBtn) {
                safeSettingsBtn.onclick = (e) => {
                    e.stopPropagation();
                    openSettings();
                };
            }

            // 移动端设置按钮
            const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
            if (mobileSettingsBtn) {
                mobileSettingsBtn.onclick = (e) => {
                    e.stopPropagation();
                    openSettings();
                };
            }

            dom.closeSettingsBtn.addEventListener('click', closeSettings);
            dom.settingsModal.addEventListener('click', (e) => {
                if (e.target === dom.settingsModal) closeSettings();
            });


            // Copy Interactions
            setupCopyInteraction('songTitle', () => dom.songTitle.textContent);
            setupCopyInteraction('artistName', () => dom.artistName.textContent);
            setupCopyInteraction('songIdTag', () => dom.songIdTag.textContent.replace('ID: ', ''));

            // Mobile Copy Interactions
            setupCopyInteraction('mobileTitle', () => dom.songTitle.textContent);
            setupCopyInteraction('mobileArtist', () => dom.artistName.textContent);
            setupCopyInteraction('mobileSongIdTag', () => dom.songIdTag.textContent.replace('ID: ', ''));

            // [需求4] 手机端设置按钮逻辑
            const settingsFullscreenBtn = document.getElementById('settingsFullscreenBtn');
            if (settingsFullscreenBtn) {
                settingsFullscreenBtn.onclick = () => {
                    toggleFullScreen();
                };
            }

            const mobileSettingsButtons = document.getElementById('mobileSettingsButtons');
            const updateMobileButtonsVisibility = () => {
                const isMobile = window.innerWidth <= 768;
                if (mobileSettingsButtons) {
                    if (isMobile) {
                        mobileSettingsButtons.classList.remove('hidden');
                    } else {
                        mobileSettingsButtons.classList.add('hidden');
                    }
                }
            };
            updateMobileButtonsVisibility();
            window.addEventListener('resize', updateMobileButtonsVisibility);
        }

        function toggleSearchPanel(forceState) {
            // Now just opens the sidebar and switches to search tab
            const shouldOpen = forceState !== undefined ? forceState : true;
            if (shouldOpen) {
                togglePlaylistPanel(true);
                switchDesktopTab('search');
                setTimeout(() => document.getElementById('searchInput')?.focus(), 200);
            } else {
                // no-op, closing is handled by togglePlaylistPanel
            }
        }

        function togglePlaylistPanel(forceState) {
            const panel = document.getElementById('floatingPlaylistPanel');
            const isOpen = !panel.classList.contains('translate-x-full');
            const shouldOpen = forceState !== undefined ? forceState : !isOpen;

            if (shouldOpen) {
                panel.classList.remove('translate-x-full');
                // 自动定位到正在播放的歌曲
                setTimeout(() => {
                    if (desktopActiveTab === 'playlist' && currentIndex !== -1) {
                        highlightCurrentSong();
                    }
                }, 300);
            } else {
                panel.classList.add('translate-x-full');
            }
        }

        // Desktop sidebar tab switching (mirroring mobile UX)
        let desktopActiveTab = 'playlist';
        function switchDesktopTab(tab) {
            desktopActiveTab = tab;
            const isPlaylist = tab === 'playlist';

            const tabPlaylist = document.getElementById('desktopTabPlaylist');
            const tabSearch = document.getElementById('desktopTabSearch');
            const contentPlaylist = document.getElementById('desktopContentPlaylist');
            const contentSearch = document.getElementById('desktopContentSearch');

            if (tabPlaylist) {
                tabPlaylist.classList.toggle('opacity-100', isPlaylist);
                tabPlaylist.classList.toggle('opacity-50', !isPlaylist);
                tabPlaylist.classList.toggle('border-primary-color', isPlaylist);
                tabPlaylist.classList.toggle('border-transparent', !isPlaylist);
            }
            if (tabSearch) {
                tabSearch.classList.toggle('opacity-100', !isPlaylist);
                tabSearch.classList.toggle('opacity-50', isPlaylist);
                tabSearch.classList.toggle('border-primary-color', !isPlaylist);
                tabSearch.classList.toggle('border-transparent', isPlaylist);
            }
            if (contentPlaylist) {
                contentPlaylist.classList.toggle('hidden', !isPlaylist);
                contentPlaylist.classList.toggle('flex', isPlaylist);
            }
            if (contentSearch) {
                contentSearch.classList.toggle('hidden', isPlaylist);
                contentSearch.classList.toggle('flex', !isPlaylist);
            }

            // Auto-focus search input
            if (!isPlaylist) {
                setTimeout(() => document.getElementById('searchInput')?.focus(), 100);
            }
        }

        // ================= Copy Interaction Logic =================
        function setupCopyInteraction(elementId, getContentFn) {
            const el = document.getElementById(elementId);
            if (!el) return;

            const handleCopy = (e) => {
                e.preventDefault(); // Stop default context menu
                const text = getContentFn();
                if (!text) return;

                // Clipboard API Hack for iFrame
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    showToast(`已复制: ${text}`);
                } catch (err) {
                    console.error('Copy failed', err);
                    showToast('复制失败', true);
                }
                document.body.removeChild(textArea);
            };

            // Desktop Right Click
            el.addEventListener('contextmenu', handleCopy);

            // Mobile Long Press Logic
            let pressTimer;
            el.addEventListener('touchstart', (e) => {
                // e.preventDefault(); // Optional: might block scrolling if not careful
                pressTimer = setTimeout(() => {
                    handleCopy(e);
                }, 600); // 600ms long press
            }, { passive: false });

            el.addEventListener('touchend', () => clearTimeout(pressTimer));
            el.addEventListener('touchmove', () => clearTimeout(pressTimer));
        }

        function showToast(msg, isError = false) {
            const toast = document.getElementById('copyToast');
            toast.querySelector('span').textContent = msg;
            toast.classList.remove('opacity-0', 'scale-90');
            toast.classList.add('opacity-100', 'scale-100');

            const icon = toast.querySelector('i');
            if (isError) {
                icon.className = "fas fa-times-circle text-red-500";
            } else {
                icon.className = "fas fa-check-circle text-primary-color";
            }

            // Auto hide
            setTimeout(() => {
                toast.classList.add('opacity-0', 'scale-90');
                toast.classList.remove('opacity-100', 'scale-100');
            }, 2000);
        }

        // ================= 设置 UI =================
        function initSettingsUI() {
            // 设置项的UI已精简，此处留空防报错
        }

        function openSettings() {
            try { if (typeof bindUserPlaylistUI === 'function') bindUserPlaylistUI(); if (typeof refreshUserPlaylistLibrary === 'function') refreshUserPlaylistLibrary(); } catch (e) {}

            dom.settingsModal.classList.remove('hidden');
            // Allow reflow
            void dom.settingsModal.offsetWidth;
            dom.settingsModal.classList.remove('opacity-0');
            dom.settingsModal.querySelector('.modal-card').classList.remove('scale-95');
            dom.settingsModal.querySelector('.modal-card').classList.add('scale-100');

            // 回显当前歌单 ID
            const idInput = document.getElementById('playlistIdInput');
            const savedId = localStorage.getItem('cp_playlistId');
            if (idInput && savedId) idInput.value = savedId;

            // 刷新歌单来源状态
            updateSourceDisplay();
        }

        function updateSourceDisplay() {
            const sourceLabel = document.getElementById('sourceLabel');
            const sourceDetail = document.getElementById('sourceDetail');
            const sourceIconI = document.getElementById('sourceIconI');
            const sourceCount = document.getElementById('sourceCount');
            if (!sourceLabel) return;

            const count = playlist ? playlist.length : 0;
            sourceCount.querySelector('div:first-child').textContent = count;

            const configs = {
                'local':       { icon: 'fas fa-hdd',            label: '本地 playlist.js',       detail: '同目录下的 playlist.js 文件自动加载' },
                'online':      { icon: 'fas fa-cloud',          label: '在线歌单',               detail: `歌单 ID: ${playlistSourceName}` },
                'cache':       { icon: 'fas fa-database',       label: '本地缓存',               detail: `歌单 ID: ${playlistSourceName}（来自 IndexedDB 缓存）` },
                'import-js':   { icon: 'fas fa-file-code',      label: '导入的 JS 歌单',         detail: `文件: ${playlistSourceName}` },
                'import-json': { icon: 'fas fa-file-alt',       label: '导入的 JSON 歌单',       detail: `文件: ${playlistSourceName}` },
                '':            { icon: 'fas fa-music',           label: '未加载歌单',             detail: '请输入歌单 ID 或导入文件' }
            };

            const cfg = configs[playlistSource] || configs[''];
            sourceIconI.className = cfg.icon + ' text-primary-color text-sm';
            sourceLabel.textContent = cfg.label;
            sourceDetail.textContent = cfg.detail;
        }

        function closeSettings() {
            dom.settingsModal.classList.add('opacity-0');
            dom.settingsModal.querySelector('.modal-card').classList.add('scale-95');
            dom.settingsModal.querySelector('.modal-card').classList.remove('scale-100');
            setTimeout(() => {
                dom.settingsModal.classList.add('hidden');
            }, 300);
        }

        function onPlayStart() {
            isPlaying = true;
            dom.playPauseBtn.innerHTML = '<i class="fas fa-pause text-2xl text-on-primary-color"></i>';
            dom.albumArtWrapper.classList.add('playing');
            if (mobileUI) mobileUI.updatePlayState(true); // ★ Mobile
            if (!audioContext) setupAudioContext();
            else if (audioContext.state === 'suspended') audioContext.resume();

            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
            }
        }

        function onPlayPause() {
            isPlaying = false;
            dom.playPauseBtn.innerHTML = '<i class="fas fa-play text-2xl ml-1 text-on-primary-color"></i>';
            dom.albumArtWrapper.classList.remove('playing');
            if (mobileUI) mobileUI.updatePlayState(false); // ★ Mobile

            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
        }

        function togglePlayPause() {
            if (!audio.src || audio.readyState === 0) {
                // 如果还未加载过歌曲，直接播放播放列表中的当前或第一首歌
                if (playlist.length) {
                    if (currentIndex === -1) {
                        if (playMode === 'random' && typeof shuffledOrder !== 'undefined' && shuffledOrder.length) {
                            currentIndex = shuffledOrder[0];
                        } else {
                            currentIndex = 0;
                        }
                    }
                    playSongAtIndex(currentIndex);
                }
            } else {
                isPlaying ? audio.pause() : audio.play();
            }
        }

        async function searchSongs(query) {
            query = query.trim();
            if (!query) return;

            if (/^\d+$/.test(query)) {
                dom.searchResults.innerHTML = Array.from({ length: 1 }).map(() => `
                    <div class="playlist-item p-2 rounded-xl flex items-center gap-3 animate-pulse opacity-50 mb-1">
                        <div class="w-10 h-10 rounded-lg bg-white/10 flex-shrink-0 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                        <div class="flex-1 min-w-0 space-y-2 py-1">
                            <div class="h-4 bg-white/10 rounded w-1/3 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                            <div class="h-3 bg-white/10 rounded w-1/4 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                        </div>
                    </div>
                `).join('');
                dom.searchResults.classList.remove('hidden');

                try {
                    const songData = await musicService.getSong(query);
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
                        renderAllPlaylistItems();
                        playSongAtIndex(targetIndex);

                        dom.searchResults.classList.add('hidden');
                        dom.searchInput.value = '';
                        showToast(`已添加并播放: ${newSong.name}`);
                    } else {
                        throw new Error('无效的歌曲ID');
                    }
                } catch (e) {
                    console.error(e);
                    dom.searchResults.innerHTML = '<div class="p-4 text-center text-red-400">无效ID或加载失败</div>';
                }
                return;
            }

            // dom.searchLoader.style.display = 'block';
            dom.searchResults.innerHTML = Array.from({ length: 10 }).map(() => `
                <div class="playlist-item p-2 rounded-xl flex items-center gap-3 animate-pulse opacity-50 mb-1">
                    <div class="w-10 h-10 rounded-lg bg-white/10 flex-shrink-0 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                    <div class="flex-1 min-w-0 space-y-2 py-1">
                        <div class="h-4 bg-white/10 rounded w-3/4 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                        <div class="h-3 bg-white/10 rounded w-1/2 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_1.5s_infinite]"></div></div>
                    </div>
                </div>
            `).join('');
            dom.searchResults.classList.remove('hidden');

            try {
                const songs = await musicService.search(query);

                // [需求4] 限制显示30条结果
                const limitedSongs = songs ? songs.slice(0, 30) : [];

                if (limitedSongs.length) {
                    dom.searchResults.innerHTML = '';
                    limitedSongs.forEach(song => {
                        const div = document.createElement('div');
                        div.className = 'playlist-item p-2 rounded-xl hover:bg-surface-container-high-color cursor-pointer flex items-center gap-3 transition-all theme-text-on-surface mb-1';

                        const sourceBadge = song.source ? `<span class="ml-2 text-[10px] px-1 rounded bg-primary-color/20 text-primary-color uppercase">${song.source}</span>` : '';

                        const coverDiv = document.createElement('div');
                        coverDiv.className = 'w-10 h-10 rounded-lg bg-surface-container-color flex-shrink-0 overflow-hidden';
                        if (song.cover) {
                            const img = document.createElement('img');
                            img.className = 'w-full h-full object-cover';
                            img.loading = 'lazy';
                            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                            window.getCachedImage(`${song.cover}?param=80y80`).then(cachedSrc => {
                                img.src = cachedSrc;
                            });
                            img.alt = song.name;
                            img.onerror = () => { img.style.display = 'none'; };
                            coverDiv.appendChild(img);
                        } else {
                            coverDiv.innerHTML = '<i class="fas fa-music text-xs opacity-30 flex items-center justify-center w-full h-full"></i>';
                        }

                        const infoDiv = document.createElement('div');
                        infoDiv.className = 'flex-1 min-w-0';
                        const titleDiv = document.createElement('div');
                        titleDiv.className = 'truncate text-sm font-medium flex items-center';
                        titleDiv.innerHTML = `${song.name}`;
                        const artistDiv = document.createElement('div');
                        artistDiv.className = 'truncate text-xs opacity-50';
                        artistDiv.textContent = song.artist || '未知艺术家';

                        infoDiv.appendChild(titleDiv);
                        infoDiv.appendChild(artistDiv);

                        div.appendChild(coverDiv);
                        div.appendChild(infoDiv);

                        const actions = document.createElement('div');
                        actions.className = 'flex items-center gap-1 flex-shrink-0';
                        const addBtn = document.createElement('button');
                        addBtn.type = 'button';
                        addBtn.className = 'js-add-queue px-2 h-8 rounded-full border border-white/30 text-xs';
                        addBtn.textContent = '+列表';
                        const plBtn = document.createElement('button');
                        plBtn.type = 'button';
                        plBtn.className = 'js-add-playlist px-2 h-8 rounded-full border border-white/30 text-xs';
                        plBtn.textContent = '歌单';
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
                        };
                        plBtn.onclick = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.openAddToPlaylistModal(newSong);
                        };
                        div.onclick = function () {
                            const targetIndex = window.insertSongToPlaylist(newSong);
                            renderAllPlaylistItems();
                            playSongAtIndex(targetIndex);
                            dom.searchResults.classList.add('hidden');
                            dom.searchInput.value = '';
                            showToast('已添加并播放: ' + newSong.name);
                        };
                        dom.searchResults.appendChild(div);
                    });
                } else {
                    dom.searchResults.innerHTML = '<div class="p-4 text-center opacity-60">未找到相关歌曲</div>';
                }
            } catch (error) {
                console.error(error);
                dom.searchResults.innerHTML = '<div class="p-4 text-center text-red-400">搜索服务暂不可用</div>';
            } finally {
                // 搜索loader已移除
            }
        }

        // ★ Helper for MediaSession
        function updateMediaSessionMetadata(data) {
            if (!('mediaSession' in navigator)) return;

            const artwork = [];
            if (data.cover) {
                const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
                const src = data.cover.replace(/^http:/, 'https:');
                sizes.forEach(size => {
                    artwork.push({
                        src: src,
                        sizes: size,
                        type: 'image/jpeg'
                    });
                });
            }

            navigator.mediaSession.metadata = new MediaMetadata({
                title: data.name || '未知歌曲',
                artist: data.artist || '未知艺术家',
                album: data.album || 'CPlayer 5',
                artwork: artwork
            });
        }

        async function loadAndPlaySong(id) {
            if (dom.desktopLoaderOverlay) dom.desktopLoaderOverlay.classList.remove('opacity-0');
            if (dom.mobileLoaderOverlay) dom.mobileLoaderOverlay.classList.remove('opacity-0');
            dom.progressBar.style.width = '0%';
            dom.currentTime.textContent = '0:00';
            dom.lyricsContainer.innerHTML = '<div class="lyric-line opacity-50 my-auto">加载中...</div>';
            dom.sourceTag.textContent = 'CHKSZ API';
            dom.songIdTag.textContent = 'ID: Load...';
            // 加载期间保持金黄色，避免视觉降级闪烁
            dom.qualityBadge.textContent = '💎JyMaster';
            dom.qualityBadge.className = 'quality-badge quality-lossless';

            try {
                // ★ 优先级调整：音频最高优先级
                // 1. 先获取音频数据并尝试播放
                const data = await musicService.getSong(id);

                if (!data || !data.url) {
                    throw new Error('No URL returned');
                }

                audio.src = data.url.replace(/^http:/, 'https:');
                dom.songTitle.textContent = data.name || '未知歌曲';
                dom.artistName.textContent = data.artist || '未知艺术家';

                try {
                    await audio.play();
                } catch (e) {
                    console.error("Auto-play blocked:", e);
                }

                // Show Source
                if (data.source) {
                    dom.sourceTag.textContent = data.source.toUpperCase() + ' API';
                }

                // Show ID
                dom.songIdTag.textContent = `ID: ${data.id}`;

                // ★ 显示音质标识
                const qualityInfo = getQualityBadge(data.url, data.br || data.bitrate);
                if (qualityInfo) {
                    dom.qualityBadge.textContent = `${qualityInfo.icon} ${qualityInfo.text}`;
                    dom.qualityBadge.className = `quality-badge ${qualityInfo.class}`;
                }

                // ★ 立即更新 MediaSession (确保锁屏有文字信息)
                // 即使封面还在加载，也先显示歌名和歌手
                updateMediaSessionMetadata(data);

                // 2. 音频开始播放后，再加载歌词和封面
                // 歌词
                LyricService.fetchLyrics(id).then(qjLyrics => {
                    const lrc = qjLyrics?.lrc || data.lrc || '';
                    const tlrc = qjLyrics?.tlrc || data.tlrc || '';
                    parseLyrics(lrc, tlrc);
                });

                // 封面 - 直接使用 URL，不再转 base64 以加速显示
                const picUrl = data.cover ? data.cover.replace(/^http:/, 'https:') : '';
                if (picUrl) {
                    // 直接设置封面 URL
                    dom.albumArt.src = picUrl;

                    // 提取背景色（extractColorsFromImage 本身支持 URL）
                    if (fluidBg && typeof fluidBg.extractColorsFromImage === 'function') {
                        fluidBg.extractColorsFromImage(picUrl);
                    }

                    // 封面加载完成后更新 MediaSession（确保锁屏封面正确）
                    const coverImg = new Image();
                    coverImg.crossOrigin = 'anonymous';
                    coverImg.onload = () => updateMediaSessionMetadata(data);
                    coverImg.src = picUrl;

                    if (mobileUI) {
                        mobileUI.updateInfo(data.name, data.artist, picUrl);
                    }
                } else {
                    if (mobileUI) mobileUI.updateInfo(data.name, data.artist, '');
                }

                if (playlist.some(p => String(p.id || p) === String(id))) {
                    currentIndex = playlist.findIndex(p => String(p.id || p) === String(id));
                    highlightCurrentSong();
                }

                // ★ Mobile UI Updates
                if (mobileUI) {
                    mobileUI.updateInfo(data.name, data.artist, picUrl);
                    mobileUI.resetView();
                    mobileUI.closeSheet();
                }

                // ★ 无缝播放：预加载下一首
                setTimeout(() => preloadNextSong(), 2000);

            } catch (e) {
                console.error(e);
                showToast('无法播放该歌曲 (版权限制或接口无响应)', true);
                dom.lyricsContainer.innerHTML = '<div class="lyric-line opacity-50 my-auto">播放失败</div>';
                // ★ Fix: 错误时也要关闭移动端播放列表弹窗，防止卡住
                if (mobileUI) {
                    mobileUI.closeSheet();
                }
            } finally {
                if (dom.desktopLoaderOverlay) dom.desktopLoaderOverlay.classList.add('opacity-0');
                if (dom.mobileLoaderOverlay) dom.mobileLoaderOverlay.classList.add('opacity-0');
            }
        }

        function updatePlayerState() {
            if (!audio.duration) return;
            const pct = (audio.currentTime / audio.duration) * 100;
            dom.progressBar.style.width = `${pct}%`;
            dom.currentTime.textContent = formatTime(audio.currentTime);

            // ★ Mobile Update
            if (mobileUI) mobileUI.updateProgress(audio.currentTime, audio.duration, pct);

            updateLyrics(audio.currentTime);
        }

        function seekAudio(e) {
            if (!audio.duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            audio.currentTime = pct * audio.duration;
        }

        // ================= 歌词逻辑 =================

        // 解析普通LRC歌词
        function parseLrc(text) {
            if (!text) return [];
            const lines = text.split('\n');
            const res = [];
            const regex = /^\[(\d{1,3}):(\d{1,2})(\.\d{1,3})?\](.*)/;

            for (let line of lines) {
                line = line.trim();
                // 跳过JSON元数据
                if (line.startsWith('{')) continue;

                const match = line.match(regex);
                if (match) {
                    const min = parseInt(match[1]);
                    const sec = parseInt(match[2]);
                    const msStr = match[3] ? match[3].substring(1) : '0';
                    const ms = parseInt(msStr.padEnd(3, '0').substring(0, 3));
                    const time = min * 60 + sec + ms / 1000;
                    const content = match[4].trim();
                    if (content) res.push({ time, text: content });
                }
            }
            return res;
        }

        function parseLyrics(lrc, tlrc) {
            // 解析普通歌词和翻译
            const origin = parseLrc(lrc);
            const trans = parseLrc(tlrc);

            // 创建翻译映射，使用更宽松的时间匹配（0.5秒容差）
            const findTranslation = (time) => {
                if (!trans || trans.length === 0) return null;

                // 精确匹配
                const exact = trans.find(t => Math.abs(t.time - time) < 0.5);
                if (exact) return exact.text;

                // 尝试四舍五入匹配
                const rounded = trans.find(t => t.time.toFixed(0) === time.toFixed(0));
                if (rounded) return rounded.text;

                return null;
            };

            parsedLyrics = origin.map(item => {
                const tText = findTranslation(item.time);

                return {
                    time: item.time,
                    text: item.text,
                    translation: tText || null
                };
            });
            renderLyrics();
        }

        function renderLyrics() {
            // Plan B: 使用 DOM 渲染
            const scroller = document.getElementById('lyricsScroller');
            const mobileScroller = document.getElementById('mobileLyricsScroller'); // ★ Mobile

            if (scroller) scroller.innerHTML = '';
            if (mobileScroller) mobileScroller.innerHTML = '';

            if (!parsedLyrics.length) {
                const emptyHTML = '<div class="lrc-line active"><span class="lrc-text">纯音乐 / 暂无歌词</span></div>';
                if (scroller) scroller.innerHTML = emptyHTML;
                if (mobileScroller) mobileScroller.innerHTML = emptyHTML;
                return;
            }

            const frag = document.createDocumentFragment();
            // Clone for mobile
            const mobileFrag = document.createDocumentFragment();

            parsedLyrics.forEach((line, idx) => {
                const div = document.createElement('div');
                div.className = 'lrc-line';
                div.dataset.time = line.time;
                div.dataset.idx = idx;

                // Click to seek
                div.onclick = () => {
                    audio.currentTime = line.time;
                    audio.play();
                };

                const spanMain = document.createElement('span');
                spanMain.className = 'lrc-text';
                spanMain.textContent = line.text;
                div.appendChild(spanMain);

                if (line.translation) {
                    const spanTrans = document.createElement('span');
                    spanTrans.className = 'lrc-trans';
                    spanTrans.textContent = line.translation;
                    div.appendChild(spanTrans);
                }

                frag.appendChild(div);
                // Mobile uses same structure, clone it
                // We need to re-attach event listener because cloneNode doesn't copy events
                const mobileDiv = div.cloneNode(true);
                mobileDiv.onclick = () => {
                    // Prevent jump if mobile playlist sheet is open
                    if (mobileUI && mobileUI.dom.sheet.classList.contains('translate-y-0')) return;

                    audio.currentTime = line.time;
                    audio.play();
                };
                mobileFrag.appendChild(mobileDiv);
            });

            if (scroller) scroller.appendChild(frag);
            if (mobileScroller) mobileScroller.appendChild(mobileFrag);

            activeLyricIndex = -1;
        }

        function updateLyrics(time) {
            if (!parsedLyrics.length) return;

            // 1. Find active index
            let idx = parsedLyrics.findIndex(l => l.time > time + 0.3);
            idx = idx === -1 ? parsedLyrics.length - 1 : idx - 1;
            if (idx < 0) idx = 0;

            // 2. Update if changed
            if (idx !== activeLyricIndex) {
                activeLyricIndex = idx;

                const updateScroller = (scrollerId) => {
                    const scroller = document.getElementById(scrollerId);
                    if (!scroller) return;

                    const lines = scroller.getElementsByClassName('lrc-line');
                    const oldActive = scroller.querySelector('.active');
                    if (oldActive) oldActive.classList.remove('active');

                    if (lines[idx]) {
                        lines[idx].classList.add('active');

                        // Scroll logic
                        const containerHeight = scroller.clientHeight;
                        const lineTop = lines[idx].offsetTop;
                        const lineHeight = lines[idx].clientHeight;
                        const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);

                        scroller.scrollTo({
                            top: targetScroll,
                            behavior: 'smooth'
                        });
                    }
                };

                updateScroller('lyricsScroller');
                updateScroller('mobileLyricsScroller'); // ★ Mobile Sync
            }
        }



        // ================= 歌单逻辑 =================
        let currentPlaylistId = localStorage.getItem('cp_playlistId') || '';
        let playlistTotalCount = 0;
        let isLoadingPlaylist = false;
        let allSongsLoaded = false;

        // 歌单来源追踪: 'local' | 'online' | 'cache' | 'import-js' | 'import-json' | ''
        let playlistSource = '';
        let playlistSourceName = ''; // 用于显示的附加信息（如歌单ID、文件名）

        // 歌单服务 - ChKSz API（无分页，一次获取全部）
        class PlaylistService {
            static async fetchPlaylist(listId) {
                const url = `${ChKSzAPI.baseUrl}/163_playlist?id=${listId}`;
                try {
                    const res = await fetch(url);
                    const json = await res.json();

                    let tracks = [];
                    // 兼容多种返回格式
                    if (json.data && Array.isArray(json.data.tracks)) {
                        tracks = json.data.tracks;
                    } else if (json.data && Array.isArray(json.data)) {
                        tracks = json.data;
                    } else if (json.playlist && Array.isArray(json.playlist.tracks)) {
                        tracks = json.playlist.tracks;
                    }

                    // 标准化歌曲数据格式（兼容 ar/al 和 artists/album 两种结构）
                    return tracks.map(item => ({
                        id: item.id,
                        name: item.name || '未知歌曲',
                        artist: item.artists
                            ? (typeof item.artists === 'string' ? item.artists : (Array.isArray(item.artists) ? item.artists.map(a => a.name).join('/') : 'Unknown'))
                            : (item.ar ? item.ar.map(a => a.name).join('/') : 'Unknown'),
                        album: typeof item.album === 'string' ? item.album : (item.al ? item.al.name : ''),
                        cover: item.picUrl || (item.al ? item.al.picUrl : '') || ''
                    }));
                } catch (e) {
                    console.warn('Playlist fetch failed:', e);
                }
                return [];
            }
        }

        function handlePlaylistUpload(e) {
            handlePlaylistFile(e.target.files[0]);
        }

        function handlePlaylistFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (Array.isArray(data)) {
                        // 支持旧格式（纯ID数组）
                        playlist = data.map(item => {
                            if (typeof item === 'object') return item;
                            return { id: String(item), name: `歌曲 ID: ${item}`, artist: '' };
                        });
                        currentIndex = -1;
                        playlistTotalCount = playlist.length;
                        allSongsLoaded = true;
                        playlistSource = 'import-json';
                        playlistSourceName = file.name;
                        initPlaylistView();
                        dom.uploadContainer.classList.add('hidden');
                        // dom.playlistInfo.classList.remove('hidden');
                    }
                } catch (err) {
                    showToast('歌单格式错误', true);
                }
            };
            reader.readAsText(file);
        }

        // 加载指定歌单
        async function loadPlaylistById(listId) {
            currentPlaylistId = listId;
            localStorage.setItem('cp_playlistId', listId);

            playlist = [];
            currentIndex = -1;
            allSongsLoaded = false;
            renderedCount = 0;

            dom.uploadContainer.classList.add('hidden');
            dom.playlistContent.innerHTML = '<div class="text-center py-4 opacity-50"><i class="fas fa-spinner fa-spin mr-2"></i>正在加载歌单...</div>';
            document.getElementById('playlistCount').textContent = '(加载中...)';

            // ★ 先尝试从 IndexedDB 缓存加载
            try {
                const cached = await getPlaylistFromCache(listId);
                if (cached && cached.songs && cached.songs.length > 0) {
                    console.log('💾 从缓存加载歌单:', cached.songs.length, '首');
                    playlist = cached.songs;
                    window.playlist = playlist;
                    scheduleSaveCurrentQueue('load_cache');
                    playlistTotalCount = playlist.length;
                    allSongsLoaded = true;
                    playlistSource = 'cache';
                    playlistSourceName = listId;
                    initPlaylistView();
                    document.getElementById('playlistCount').textContent = `(${playlist.length}首)`;

                    // 后台静默更新缓存
                    setTimeout(() => refreshPlaylistInBackground(listId), 5000);
                    return;
                }
            } catch (e) {
                console.warn('缓存读取失败:', e);
            }

            // 从 API 加载
            await fetchAndLoadPlaylist(listId);
        }

        // 后台静默更新歌单缓存
        async function refreshPlaylistInBackground(listId) {
            console.log('🔄 后台更新播放列表缓存...');
            try {
                const freshSongs = await PlaylistService.fetchPlaylist(listId);
                if (freshSongs.length > 0) {
                    await savePlaylistToCache(listId, freshSongs);
                    console.log('✅ 播放列表缓存已更新:', freshSongs.length, '首');
                    // 后台更新成功后，来源标记为在线
                    if (playlistSource === 'cache') {
                        playlistSource = 'online';
                        playlistSourceName = listId;
                    }
                    if (freshSongs.length !== playlist.length) {
                        document.getElementById('playlistCount').textContent = `(${freshSongs.length}首)`;
                    }
                }
            } catch (e) {
                console.warn('后台更新失败:', e);
            }
        }

        // 从 API 获取并加载歌单（单次请求）
        async function fetchAndLoadPlaylist(listId) {
            isLoadingPlaylist = true;
            try {
                const songs = await PlaylistService.fetchPlaylist(listId);

                if (songs.length === 0) {
                    throw new Error('歌单为空或不存在');
                }

                playlist = songs;
                window.playlist = playlist;
                scheduleSaveCurrentQueue('load_online');
                playlistTotalCount = playlist.length;
                allSongsLoaded = true;
                playlistSource = 'online';
                playlistSourceName = listId;

                document.getElementById('playlistCount').textContent = `(${playlist.length}首)`;
                initPlaylistView();

                // ★ 保存到 IndexedDB 缓存
                await savePlaylistToCache(listId, playlist);
                console.log('💾 播放列表已缓存:', playlist.length, '首');

            } catch (e) {
                console.error('播放列表加载失败:', e);
                showToast('播放列表加载失败，请检查歌单ID是否正确', true);
                throw e;
            } finally {
                isLoadingPlaylist = false;
                const loader = document.getElementById('playlistLoader');
                if (loader) loader.classList.add('hidden');
            }
        }

        async function loadDefaultPlaylist() {
            try {
                if (window.LOCAL_PLAYLIST && window.LOCAL_PLAYLIST.data && window.LOCAL_PLAYLIST.data.tracks) {
                    const tracks = window.LOCAL_PLAYLIST.data.tracks;
                    suppressQueueAutosave = true;
                    playlist = tracks.map(function (item) {
                        return {
                            id: item.id,
                            name: item.name,
                            artist: item.artists || 'Unknown',
                            cover: item.picUrl || '',
                            album: item.album || ''
                        };
                    });
                    window.playlist = playlist;
                    playlistTotalCount = playlist.length;
                    allSongsLoaded = true;
                    playlistSource = 'local';
                    playlistSourceName = window.LOCAL_PLAYLIST.title || 'playlist.js';
                    if (typeof initPlaylistView === 'function') initPlaylistView();
                    suppressQueueAutosave = false;
                    if (typeof scheduleSaveCurrentQueue === 'function') scheduleSaveCurrentQueue('boot_js');
                    return;
                }

                const savedId = localStorage.getItem('cp_playlistId');
                const queueDirty = localStorage.getItem('cp_queue_dirty') === '1';
                let restored = false;
                if (queueDirty || !savedId) {
                    restored = await restoreCurrentQueue();
                }
                if (restored) return;
                if (savedId && typeof loadPlaylistById === 'function') {
                    await loadPlaylistById(savedId);
                    return;
                }
                restored = await restoreCurrentQueue();
                if (restored) return;

                // empty start - searchable, no forced modal
                playlist = [];
                window.playlist = playlist;
                currentIndex = -1;
                allSongsLoaded = true;
                playlistSource = 'empty';
                playlistSourceName = '直接搜索';
                if (typeof initPlaylistView === 'function') initPlaylistView();
            } catch (e) {
                console.error('[boot]', e);
            }
        }

        // 从输入值中提取歌单 ID（支持纯数字、完整链接）
        function extractPlaylistId(raw) {
            const s = String(raw || '').trim();
            const m = s.match(/(\d{5,})/);
            return m ? m[1] : '';
        }

        // 解析 playlist.js 文件内容（window.LOCAL_PLAYLIST = {...};）
        function parsePlaylistJsContent(text) {
            // 尝试提取 JSON 对象
            const match = text.match(/window\.LOCAL_PLAYLIST\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
            if (match) {
                try {
                    const obj = JSON.parse(match[1]);
                    if (obj && obj.data && Array.isArray(obj.data.tracks)) {
                        return obj.data.tracks.map(item => ({
                            id: item.id,
                            name: item.name || '未知歌曲',
                            artist: typeof item.artists === 'string'
                                ? item.artists
                                : (Array.isArray(item.artists)
                                    ? item.artists.map(a => typeof a === 'string' ? a : a.name).join('/')
                                    : (Array.isArray(item.ar) ? item.ar.map(a => a.name).join('/') : 'Unknown')),
                            cover: item.picUrl || (item.al ? item.al.picUrl : '') || '',
                            album: typeof item.album === 'string'
                                ? item.album
                                : (item.album?.name || item.al?.name || '')
                        }));
                    }
                } catch (e) {
                    console.warn('playlist.js JSON parse failed:', e);
                }
            }
            return null;
        }

        // 处理导入的文件（.js 或 .json）
        function handleImportedFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target.result;
                const isJs = file.name.endsWith('.js');

                if (isJs) {
                    const tracks = parsePlaylistJsContent(text);
                    if (tracks && tracks.length > 0) {
                        playlist = tracks;
                        window.playlist = playlist;
                        currentIndex = -1;
                        playlistTotalCount = playlist.length;
                        allSongsLoaded = true;
                        playlistSource = 'import-js';
                        playlistSourceName = file.name;
                        initPlaylistView();
                        showToast(`已导入 ${playlist.length} 首歌曲`);
                        closeSettings();
                        return;
                    }
                    showToast('无法解析该 .js 文件，请确认格式正确', true);
                    return;
                }

                // JSON 格式
                handlePlaylistFile(file);
                closeSettings();
            };
            reader.readAsText(file);
        }

        // 手动加载歌单按钮事件
        function setupPlaylistIdLoader() {
            const btn = document.getElementById('loadPlaylistBtn');
            const input = document.getElementById('playlistIdInput');

            if (btn && input) {
                btn.onclick = () => {
                    const id = extractPlaylistId(input.value);
                    if (id) {
                        loadPlaylistById(id);
                        closeSettings();
                    } else {
                        showToast('请输入有效的歌单 ID（至少5位数字）', true);
                    }
                };

                input.onkeypress = (e) => {
                    if (e.key === 'Enter') btn.click();
                };
            }

            // 设置模态框内的拖拽区域
            const dropZone = document.getElementById('settingsDropZone');
            const fileInput = document.getElementById('settingsFileInput');

            if (dropZone && fileInput) {
                dropZone.addEventListener('click', () => fileInput.click());

                fileInput.addEventListener('change', (e) => {
                    if (e.target.files[0]) handleImportedFile(e.target.files[0]);
                });

                dropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropZone.classList.add('border-primary-color/60', 'bg-white/[0.06]');
                });

                dropZone.addEventListener('dragleave', () => {
                    dropZone.classList.remove('border-primary-color/60', 'bg-white/[0.06]');
                });

                dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    dropZone.classList.remove('border-primary-color/60', 'bg-white/[0.06]');
                    const file = e.dataTransfer.files[0];
                    if (file && (file.name.endsWith('.js') || file.name.endsWith('.json'))) {
                        handleImportedFile(file);
                    } else {
                        showToast('请拖入 .js 或 .json 文件', true);
                    }
                });
            }

            // 全局拖拽支持（拖文件到页面任意位置）
            setupGlobalDragDrop();
        }

        // 全局拖拽覆盖层
        function setupGlobalDragDrop() {
            let dragOverlay = null;
            let dragCounter = 0;

            function createOverlay() {
                if (dragOverlay) return dragOverlay;
                dragOverlay = document.createElement('div');
                dragOverlay.id = 'globalDropOverlay';
                dragOverlay.style.cssText = `
                    position: fixed; inset: 0; z-index: 9999;
                    background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
                    display: flex; align-items: center; justify-content: center;
                    opacity: 0; transition: opacity 0.25s ease;
                    pointer-events: none;
                `;
                dragOverlay.innerHTML = `
                    <div style="text-align:center; color:#fff;">
                        <i class="fas fa-file-import" style="font-size:48px; opacity:0.7; margin-bottom:16px; display:block;"></i>
                        <div style="font-size:18px; font-weight:700; margin-bottom:6px;">释放以导入歌单</div>
                        <div style="font-size:13px; opacity:0.5;">支持 playlist.js 和 .json 文件</div>
                    </div>
                `;
                document.body.appendChild(dragOverlay);
                return dragOverlay;
            }

            document.addEventListener('dragenter', (e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                dragCounter++;
                const overlay = createOverlay();
                overlay.style.pointerEvents = 'auto';
                requestAnimationFrame(() => overlay.style.opacity = '1');
            });

            document.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
            });

            document.addEventListener('dragleave', (e) => {
                dragCounter--;
                if (dragCounter <= 0) {
                    dragCounter = 0;
                    if (dragOverlay) {
                        dragOverlay.style.opacity = '0';
                        dragOverlay.style.pointerEvents = 'none';
                    }
                }
            });

            document.addEventListener('drop', (e) => {
                dragCounter = 0;
                if (dragOverlay) {
                    dragOverlay.style.opacity = '0';
                    dragOverlay.style.pointerEvents = 'none';
                }

                const file = e.dataTransfer && e.dataTransfer.files[0];
                if (!file) return;

                // 如果拖到了设置模态框里的 dropZone，让那边的 handler 处理
                const settingsDropZone = document.getElementById('settingsDropZone');
                if (settingsDropZone && settingsDropZone.contains(e.target)) return;

                e.preventDefault();
                if (file.name.endsWith('.js') || file.name.endsWith('.json')) {
                    handleImportedFile(file);
                } else {
                    showToast('不支持的文件格式，请使用 .js 或 .json', true);
                }
            });
        }

        // ================= 欢迎引导模态框 =================
        function openWelcomeModal() {
            const modal = document.getElementById('welcomeModal');
            const card = document.getElementById('welcomeCard');
            if (!modal || !card) return;

            modal.classList.remove('hidden');
            void modal.offsetWidth;
            modal.classList.remove('opacity-0');
            card.classList.remove('scale-95');
            card.classList.add('scale-100');

            // Focus input
            setTimeout(() => {
                const input = document.getElementById('welcomePlaylistInput');
                if (input) input.focus();
            }, 400);
        }

        function closeWelcomeModal() {
            const modal = document.getElementById('welcomeModal');
            const card = document.getElementById('welcomeCard');
            if (!modal || !card) return;

            modal.classList.add('opacity-0');
            card.classList.add('scale-95');
            card.classList.remove('scale-100');
            setTimeout(() => {
                modal.classList.add('hidden');
                // Reset states
                const loading = document.getElementById('welcomeLoading');
                const error = document.getElementById('welcomeError');
                if (loading) loading.classList.add('hidden');
                if (error) error.classList.add('hidden');
            }, 500);
        }

        async function submitWelcomePlaylist() {
            const input = document.getElementById('welcomePlaylistInput');
            const errorDiv = document.getElementById('welcomeError');
            const errorText = document.getElementById('welcomeErrorText');
            const loadingDiv = document.getElementById('welcomeLoading');
            const loadBtn = document.getElementById('welcomeLoadBtn');

            const rawId = input.value.trim();

            // 支持纯数字ID或从链接中提取ID
            const idMatch = rawId.match(/(\d{5,})/);
            if (!idMatch) {
                errorDiv.classList.remove('hidden');
                errorText.textContent = '请输入有效的歌单ID（纯数字，或包含歌单ID的链接）';
                input.classList.add('border-red-400/50');
                setTimeout(() => input.classList.remove('border-red-400/50'), 2000);
                return;
            }

            const playlistId = idMatch[1];
            errorDiv.classList.add('hidden');

            // Show loading
            loadingDiv.classList.remove('hidden');
            loadBtn.disabled = true;

            try {
                await loadPlaylistById(playlistId);

                // Success!
                document.getElementById('welcomeLoadingText').textContent = '加载成功！';
                document.getElementById('welcomeLoadingSubtext').textContent = `已加载 ${playlist.length} 首歌曲`;

                showToast(`🎵 歌单加载成功！共 ${playlist.length} 首歌曲`);

                setTimeout(() => {
                    closeWelcomeModal();
                }, 800);

            } catch (e) {
                // Failed
                loadingDiv.classList.add('hidden');
                loadBtn.disabled = false;
                errorDiv.classList.remove('hidden');
                errorText.textContent = '歌单加载失败，请检查ID是否正确或网络是否正常';
            }
        }

        // 欢迎模态框事件绑定（module script 执行时 DOM 已 ready，直接绑定）
        {
            const welcomeInput = document.getElementById('welcomePlaylistInput');
            const welcomeBtn = document.getElementById('welcomeLoadBtn');
            if (welcomeInput) {
                welcomeInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') submitWelcomePlaylist();
                });
            }
            if (welcomeBtn) {
                welcomeBtn.addEventListener('click', submitWelcomePlaylist);
            }
        }

        function initPlaylistView() {
            const countText = allSongsLoaded ? `(${playlist.length}首)` : `(${playlist.length}+首)`;
            document.getElementById('playlistCount').textContent = countText;

            // 打乱播放顺序（如果是随机模式）
            if (playMode === 'random') {
                shufflePlaylist();
            }

            // 虚拟滚动渲染
            setupVirtualScroll();

            // 隐藏加载器
            document.getElementById('playlistLoader').classList.add('hidden');
        }

        // ================= 桌面端虚拟滚动 =================
        const VS_ITEM_H = 52;       // 每项高度 (px)
        const VS_BUFFER = 30;       // 上下各多渲染30项
        let vsDisplayOrder = [];     // 当前显示顺序
        let vsRenderedRange = { start: -1, end: -1 };  // 当前已渲染范围
        let vsScrollRAF = null;      // 防抖 requestAnimationFrame
        let vsNodeMap = new Map();   // displayIndex -> DOM node

        function getDisplayOrder() {
            if (playMode === 'random' && shuffledOrder.length === playlist.length) {
                return shuffledOrder;
            }
            return playlist.map((_, i) => i);
        }

        function setupVirtualScroll() {
            vsDisplayOrder = getDisplayOrder();
            vsRenderedRange = { start: -1, end: -1 };
            vsNodeMap.clear();

            if (!playlist.length) {
                dom.playlistContent.innerHTML = '<div class="text-center py-8 opacity-50">播放列表为空</div>';
                dom.playlistContent.style.height = '';
                dom.playlistContent.style.position = '';
                return;
            }

            const totalHeight = vsDisplayOrder.length * VS_ITEM_H;
            dom.playlistContent.innerHTML = '';
            dom.playlistContent.style.height = totalHeight + 'px';
            dom.playlistContent.style.position = 'relative';

            vsRenderVisible(true);

            dom.playlistContainer.onscroll = () => {
                if (vsScrollRAF) return;
                vsScrollRAF = requestAnimationFrame(() => {
                    vsScrollRAF = null;
                    vsRenderVisible(false);
                });
            };
        }

        function vsCreateItem(i) {
            const actualIndex = vsDisplayOrder[i];
            const song = playlist[actualIndex];
            const songId = typeof song === 'object' ? song.id : song;
            const songName = typeof song === 'object' ? song.name : `歌曲 ID: ${song}`;
            const songArtist = typeof song === 'object' ? song.artist : '';
            const songCover = typeof song === 'object' ? song.cover : '';

            const div = document.createElement('div');
            div.className = 'playlist-item p-2 rounded-xl hover:bg-surface-container-high-color cursor-pointer flex items-center gap-3 group theme-text-on-surface';
            div.dataset.idx = actualIndex;
            div.dataset.vsIdx = i;
            div.style.cssText = `position:absolute;top:${i * VS_ITEM_H}px;left:0;right:0;height:${VS_ITEM_H}px;`;

            if (actualIndex === currentIndex) {
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

            div.appendChild(numSpan);
            div.appendChild(coverDiv);
            div.appendChild(infoDiv);

            div.onclick = () => {
                currentIndex = actualIndex;
                loadAndPlaySong(songId);
            };
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'js-remove-queue p-2 w-8 h-8 flex items-center justify-center rounded-full border border-white/15 text-xs opacity-70';
            delBtn.innerHTML = '<i class="fas fa-trash"></i>';
            delBtn.onclick = function (e) {
                e.stopPropagation();
                window.removeSongFromQueue(actualIndex);
            };
            div.appendChild(delBtn);
            return div;
        }

        function vsRenderVisible(forceRebuild) {
            const scrollTop = dom.playlistContainer.scrollTop;
            const viewHeight = dom.playlistContainer.clientHeight;
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
                dom.playlistContent.innerHTML = '';
                vsNodeMap.clear();
                const frag = document.createDocumentFragment();
                for (let i = newStart; i < newEnd; i++) {
                    const node = vsCreateItem(i);
                    vsNodeMap.set(i, node);
                    frag.appendChild(node);
                }
                dom.playlistContent.appendChild(frag);
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
                if (added) dom.playlistContent.appendChild(frag);
            }

            vsRenderedRange = { start: newStart, end: newEnd };
        }

        // 一次性渲染播放列表（保留作为兼容入口，内部走虚拟滚动）
        function renderAllPlaylistItems() {
            setupVirtualScroll();
        }

        // 保留旧函数名以兼容
        function renderPlaylistChunk() {
            renderAllPlaylistItems();
        }

        // Expose functions globally for Mobile UI
        window.playSongAtIndex = (index) => {
            if (index < 0 || index >= playlist.length) return;
            currentIndex = index;
            scheduleSaveCurrentQueue('play_index'); // Sync with global variable
            // currentSongIndex = index; // Removed if not defined

            const song = playlist[index];
            const songId = typeof song === 'object' ? song.id : song;

            loadAndPlaySong(songId);

            // Sync mobile playlist view if active
            if (mobileUI && mobileUI.activeSheetTab === 'playlist') {
                mobileUI.loadPlaylist();
            }
        };

        function highlightCurrentSong() {
            // 移除旧的高亮
            const old = dom.playlistContent.querySelector('.playing-item');
            if (old) old.classList.remove('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');

            // 添加新的高亮（如果当前歌曲在可见区域内）
            let el = dom.playlistContent.querySelector(`div[data-idx="${currentIndex}"]`);
            if (el) {
                el.classList.add('bg-primary-color/20', 'text-primary-color', 'font-bold', 'border-l-4', 'border-primary-color', 'pl-2', 'playing-item', 'shadow-md');
            }

            // 滚动到当前歌曲在显示顺序中的位置
            const displayPos = vsDisplayOrder.indexOf(currentIndex);
            if (displayPos !== -1) {
                const targetTop = displayPos * VS_ITEM_H - dom.playlistContainer.clientHeight / 2 + VS_ITEM_H / 2;
                dom.playlistContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
            }
        }

        function playNextSong() {
            if (!playlist.length) return;
            // ★ Fix: 首次播放时（currentIndex === -1），直接从第一首开始
            if (currentIndex === -1) {
                if (playMode === 'random' && shuffledOrder.length === playlist.length) {
                    currentIndex = shuffledOrder[0];
                } else {
                    currentIndex = 0;
                }
            } else {
                currentIndex = getNextSongIndex();
            }
            const song = playlist[currentIndex];
            const songId = typeof song === 'object' ? song.id : song;
            loadAndPlaySong(songId);
        }

        function playPreviousSong() {
            if (!playlist.length) return;
            // ★ Fix: 首次播放时（currentIndex === -1），直接从第一首开始
            if (currentIndex === -1) {
                if (playMode === 'random' && shuffledOrder.length === playlist.length) {
                    currentIndex = shuffledOrder[0];
                } else {
                    currentIndex = 0;
                }
            } else {
                currentIndex = getPreviousSongIndex();
            }
            const song = playlist[currentIndex];
            const songId = typeof song === 'object' ? song.id : song;
            loadAndPlaySong(songId);
        }

        function handleSongEnd() {
            if (playMode === 'single') {
                audio.currentTime = 0;
                audio.play();
            } else {
                playNextSong();
            }
        }

        function togglePlayMode() {
            const modes = ['sequence', 'random', 'single'];
            const icons = ['fa-list-ol', 'fa-random', 'fa-repeat'];
            let idx = modes.indexOf(playMode);
            idx = (idx + 1) % modes.length;
            playMode = modes[idx];
            if (playMode === 'random') {
                shufflePlaylist();
            }
            dom.playModeBtn.innerHTML = `<i class="fas ${icons[idx]} text-xl"></i>`;
            dom.playModeBtn.style.opacity = '1';

            // ★ 同步移动端模式按钮图标
            if (mobileUI && mobileUI.dom.modeBtn) {
                mobileUI.dom.modeBtn.innerHTML = `<i class="fas ${icons[idx]} text-xl"></i>`;
            }

            // 立即重绘列表以反映打乱或恢复顺序的UI
            renderAllPlaylistItems();
            highlightCurrentSong();
            // ★ 同步移动端播放列表
            if (mobileUI) mobileUI.loadPlaylist();
        }

        // ================= 视觉与主题 =================
        function setupAudioContext() {
            // IMPORTANT for mobile background playback:
            // Do NOT call createMediaElementSource. Once routed into WebAudio,
            // many mobile browsers suspend AudioContext when backgrounded and mute sound.
            // Keep <audio> on the native output path only (same as sites that work in background).
            if (window.__audioGraphDisabledLogged) return;
            window.__audioGraphDisabledLogged = true;
            audioContext = null;
            analyser = null;
            gainNode = null;
            compressorNode = null;
            console.log('[audio] native <audio> path only (background-safe, no quality loss)');
        }

        // ================= 安全插入歌曲到播放列表 =================
        window.insertSongToPlaylist = function (newSong) {
            if (currentIndex === -1) currentIndex = playlist.length > 0 ? playlist.length - 1 : 0;

            if (playlist.length === 0) {
                playlist.push(newSong);
                window.playlist = playlist;
                if (playMode === 'random') shuffledOrder = [0];
                scheduleSaveCurrentQueue('insert_empty');
                return 0;
            }

            const insertIndex = currentIndex + 1;
            playlist.splice(insertIndex, 0, newSong);
            window.playlist = playlist;

            if (playMode === 'random') {
                for (let i = 0; i < shuffledOrder.length; i++) {
                    if (shuffledOrder[i] >= insertIndex) {
                        shuffledOrder[i]++;
                    }
                }
                let currentShufflePos = shuffledOrder.indexOf(currentIndex);
                if (currentShufflePos === -1) currentShufflePos = shuffledOrder.length - 1;
                shuffledOrder.splice(currentShufflePos + 1, 0, insertIndex);
            }

            scheduleSaveCurrentQueue('insert');
            return insertIndex;
        };
;

        function initVisualizer() {
            const canvas = document.getElementById('audioVisualizer');
            const ctx = canvas.getContext('2d');

            if (!audioContext && isPlaying) setupAudioContext();

            function resize() {
                // 画布比封面大一些，用来画波形
                const coverSizePx = parseInt(getComputedStyle(dom.html).getPropertyValue('--cover-size'));
                const size = coverSizePx + 100; // 留足空间画波浪
                canvas.width = size;
                canvas.height = size;
            }
            window.addEventListener('resize', resize);
            resize();

            const bufferLength = analyser ? analyser.frequencyBinCount : 128;
            const dataArray = new Uint8Array(bufferLength);

            let frameCount = 0;

            function draw() {
                requestAnimationFrame(draw);

                // 1. 实验性功能：背景激荡逻辑 (已移除 isGradientMode 依赖)
                // if (analyser && isPlaying && ++frameCount % 5 === 0) {
                // 移除旧的背景逻辑，避免报错
                // }

                // 2. 清空画布
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (!analyser || !isPlaying) return;

                // 3. Siri 环形波形绘制 (Experimental)
                analyser.getByteFrequencyData(dataArray);

                const centerX = canvas.width / 2;
                const centerY = canvas.height / 2;
                // 半径基于封面大小，确保紧贴边缘
                const coverRadius = (canvas.width - 100) / 2;
                const radius = coverRadius + 5; // 基础半径比封面稍大

                ctx.beginPath();

                // 获取主色调
                const primaryColor = getComputedStyle(dom.html).getPropertyValue('--primary-color').trim();
                ctx.strokeStyle = primaryColor;
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';

                const skipLow = Math.floor(bufferLength * 0.1);  // 跳过最低的10%频率
                const skipHigh = Math.floor(bufferLength * 0.1); // 跳过最高的10%频率
                const midStart = skipLow;
                const midEnd = bufferLength - skipHigh;
                const sliceLen = midEnd - midStart;
                const angleStep = (Math.PI * 2) / sliceLen;

                for (let i = 0; i < sliceLen; i++) {
                    const dataIndex = midStart + i; // 从中间频段开始取值
                    const value = dataArray[dataIndex];
                    // 动态计算波幅：中频区域更平滑
                    const amp = (value / 255) * 40;

                    const angle = i * angleStep - (Math.PI / 2); // 从顶部开始

                    // 计算外圈波形的坐标
                    // 使用正弦波平滑处理，避免锯齿
                    const r = radius + amp;

                    const x = centerX + Math.cos(angle) * r;
                    const y = centerY + Math.sin(angle) * r;

                    if (i === 0) {
                        ctx.moveTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                }

                // 闭合路径
                ctx.closePath();

                // 添加发光效果
                ctx.shadowBlur = 15;
                ctx.shadowColor = primaryColor;

                ctx.stroke();

                // 重置阴影，避免影响性能
                ctx.shadowBlur = 0;
            }
            draw();
        }

        // rgbToHsl - 保留供流体背景使用
        function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h, s, l = (max + min) / 2;
            if (max === min) h = s = 0;
            else {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                    case g: h = (b - r) / d + 2; break;
                    case b: h = (r - g) / d + 4; break;
                }
                h /= 6;
            }
            return { h: Math.round(h * 360), s, l };
        }

        function toggleFullScreen() {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => {
                    showToast(`无法启用全屏: ${err.message}`, true);
                });
                document.querySelector('#fullscreenBtn i').classList.replace('fa-expand', 'fa-compress');
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                    document.querySelector('#fullscreenBtn i').classList.replace('fa-compress', 'fa-expand');
                }
            }
        }




        // 沉浸模式状态
        let isImmersiveMode = false;

        function toggleImmersiveMode() {
            isImmersiveMode = !isImmersiveMode;
            const topSection = document.getElementById('topSectionArea');
            const btn = document.getElementById('immersiveModeBtn');
            const btnText = document.getElementById('immersiveModeText');
            const btnIcon = btn ? btn.querySelector('i') : null;

            if (topSection) {
                if (isImmersiveMode) {
                    topSection.classList.add('immersive-hidden');
                    if (btnText) btnText.textContent = '退出沉浸模式';
                    if (btnIcon) {
                        btnIcon.classList.remove('fa-eye');
                        btnIcon.classList.add('fa-eye-slash');
                    }
                    if (btn) btn.classList.add('bg-primary-color', 'text-on-primary-color');
                } else {
                    topSection.classList.remove('immersive-hidden');
                    if (btnText) btnText.textContent = '开启沉浸模式';
                    if (btnIcon) {
                        btnIcon.classList.remove('fa-eye-slash');
                        btnIcon.classList.add('fa-eye');
                    }
                    if (btn) btn.classList.remove('bg-primary-color', 'text-on-primary-color');
                }
            }

            // 保存状态
            localStorage.setItem('cp_immersiveMode', isImmersiveMode ? 'on' : 'off');
        }

        function initImmersiveMode() {
            // 绑定沉浸模式按钮事件
            const immersiveModeBtn = document.getElementById('immersiveModeBtn');
            if (immersiveModeBtn) {
                immersiveModeBtn.onclick = toggleImmersiveMode;
            }

            // 恢复保存的状态
            const savedMode = localStorage.getItem('cp_immersiveMode');
            if (savedMode === 'on') {
                toggleImmersiveMode();
            }
        }

        function formatTime(s) {
            if (isNaN(s)) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${m}:${sec.toString().padStart(2, '0')}`;
        }
        function updateVolumeIcon(vol) {
            let icon = 'fa-volume-mute';
            if (vol > 0.5) icon = 'fa-volume-up';
            else if (vol > 0) icon = 'fa-volume-down';
            dom.volumeBtn.innerHTML = `<i id="volumeIcon" class="fas ${icon} text-xl"></i>`;
        }

        // ================= ★ WebGL 流体背景渲染器 (参考 aura-music 风格) =================
        // ================= ★ Mobile UI Manager (Updated) =================
        class MobileUIManager {
            constructor() {
                this.isMobile = window.innerWidth < 768;
                this.currentMode = 'cover';
                this.activeSheetTab = 'playlist'; // playlist | search

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
                // 延迟执行 initial resize 以确保 DOM就绪
                requestAnimationFrame(() => this.handleResize());
                window.addEventListener('resize', () => this.handleResize());

                // Preload Playlist (Wait for global playlist to be ready)
                const checkPlaylist = setInterval(() => {
                    if (window.playlist && window.playlist.length > 0) {
                        this.loadPlaylist();
                        clearInterval(checkPlaylist);

                        // Initial scroll to current song if playing
                        setTimeout(() => {
                            const activeItem = document.getElementById('mobile-playing-item');
                            if (activeItem) {
                                activeItem.scrollIntoView({ block: 'center', behavior: 'auto' });
                            }
                        }, 500);
                    }
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
                        if (!sheet.contains(e.target) && !toggleBtn.contains(e.target)) {
                            this.closeSheet();
                        }
                    }
                });

                // Sync Controls
                this.dom.playBtn?.addEventListener('click', togglePlayPause);
                this.dom.prevBtn?.addEventListener('click', playPreviousSong);
                this.dom.nextBtn?.addEventListener('click', playNextSong);
                this.dom.modeBtn?.addEventListener('click', togglePlayMode);

                // Progress
                this.dom.progressContainer?.addEventListener('click', (e) => {
                    const rect = this.dom.progressContainer.getBoundingClientRect();
                    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    if (audio.duration) {
                        audio.currentTime = percent * audio.duration;
                        updateProgress();
                    }
                });
            }

            bindSheetEvents() {
                // Toggle Sheet
                this.dom.sheetToggleBtn?.addEventListener('click', () => this.openSheet());
                this.dom.closeSheetBtn?.addEventListener('click', () => this.closeSheet());

                // Switch Tabs
                this.dom.tabPlaylist?.addEventListener('click', () => this.switchSheetTab('playlist'));
                this.dom.tabSearch?.addEventListener('click', () => this.switchSheetTab('search'));

                // Search Input
                this.dom.searchInput?.addEventListener('change', (e) => {
                    this.handleSearch(e.target.value);
                });
                this.dom.searchInput?.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.handleSearch(e.target.value);
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
            }

            closeSheet() {
                this.dom.sheet.style.transform = ''; // 清除拖拽残留
                this.dom.sheet.classList.remove('translate-y-0');
                this.dom.sheet.classList.add('translate-y-[110%]');
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
            }

            // Data Logic
            loadPlaylist() { // Virtual scroll for mobile playlist (diff-based)
                try {
                    if (!window.playlist || !Array.isArray(window.playlist)) return;

                    const container = this.dom.playlistContainer;
                    const scrollParent = container.parentElement; // sheetContentPlaylist

                    let displayOrder = [];
                    if (playMode === 'random' && shuffledOrder.length === window.playlist.length) {
                        displayOrder = shuffledOrder;
                    } else {
                        displayOrder = window.playlist.map((_, i) => i);
                    }

                    const MH = 58;  // item height
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

                    function mCreateItem(i) {
                        const actualIndex = displayOrder[i];
                        const song = window.playlist[actualIndex];
                        const isPlaying = actualIndex === currentIndex;
                        const textClass = isPlaying ? 'text-primary-color' : 'text-white/90';
                        const coverSrc = song.cover || '';

                        const div = document.createElement('div');
                        div.className = `flex items-center gap-3 px-3 rounded-xl cursor-pointer border-b border-white/5 ${isPlaying ? 'bg-white/10' : ''}`;
                        div.style.cssText = `position:absolute;top:${i * MH}px;left:0;right:0;height:${MH}px;display:flex;align-items:center;`;
                        div.dataset.mvsIdx = i;
                        if (isPlaying) div.id = 'mobile-playing-item';

                        div.innerHTML = `
                            <span class="text-xs font-mono opacity-50 w-6 text-center flex-none">${i + 1}</span>
                            <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" class="w-10 h-10 rounded-lg object-cover bg-white/5 flex-none" loading="lazy" crossorigin="anonymous">
                            <div class="flex-1 min-w-0">
                                <div class="font-bold truncate text-sm ${textClass}">${song.name}</div>
                                <div class="text-xs truncate opacity-50">${song.artist || ''}</div>
                            </div>
                            <button type="button" class="js-remove-queue flex-none w-12 h-9 rounded-full border border-white/25 flex items-center justify-center text-white/85 text-xs active:bg-red-500/40" title="删除" aria-label="删除" style="pointer-events:auto;z-index:5;position:relative;">
                                删
                            </button>
                        `;
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
                        div.onclick = () => {
                            playSongAtIndex(actualIndex);
                            self.closeSheet();
                        };

                        if (coverSrc) {
                            const img = div.querySelector('img');
                            window.getCachedImage(`${coverSrc}?param=80y80`).then(cachedSrc => {
                                if (img.isConnected) img.src = cachedSrc;
                            });
                        }
                        return div;
                    }

                    function mRender(force) {
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
                    }

                    mRender(true);

                    scrollParent.onscroll = () => {
                        if (mRAF) return;
                        mRAF = requestAnimationFrame(() => {
                            mRAF = null;
                            mRender(false);
                        });
                    };

                    // 自动滚动到当前播放
                    const playingPos = displayOrder.indexOf(currentIndex);
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

            async handleSearch(query) {
                if (!query.trim()) return;

                // [紧急Fix] 纯数字ID直接添加并播放
                if (/^\d+$/.test(query.trim())) {
                    const container = this.dom.searchResults;
                    container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">正在加载ID歌曲...</div>';

                    try {
                        const songData = await musicService.getSong(query.trim());
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
                            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                            this.loadPlaylist();

                            // 播放
                            window.playSongAtIndex(targetIndex);

                            this.closeSheet();
                            showToast(`已添加并播放: ${newSong.name}`);
                            if (this.dom.searchInput) this.dom.searchInput.value = '';
                        } else {
                            container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">无效的ID</div>';
                        }
                    } catch (e) {
                        console.error(e);
                        container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">加载失败</div>';
                    }
                    return;
                }

                const container = this.dom.searchResults;
                container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">搜索中...</div>';

                try {
                    // Use global musicService instance
                    const results = await musicService.search(query);
                    container.innerHTML = '';

                    if (!results || results.length === 0) {
                        container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs">无结果</div>';
                        return;
                    }

                    results.forEach(song => {
                        const div = document.createElement('div');
                        div.className = 'flex items-center gap-3 p-2 rounded-xl active:bg-white/5 transition-colors cursor-pointer';

                        const searchId = `mob-search-img-${song.id}-${Math.random().toString(36).substr(2, 5)}`;
                        div.innerHTML = `
                            <img id="${searchId}" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCI+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iIzMzMyIvPjwvc3ZnPg==" class="w-10 h-10 rounded-lg object-cover bg-white/5 flex-none shadow-md" loading="lazy" crossorigin="anonymous">
                            <div class="flex-1 min-w-0">
                                <div class="font-bold truncate text-sm text-white/90">${song.name}</div>
                                <div class="text-xs truncate opacity-50">${song.artist}</div>
                            </div>
                            <button type="button" class="js-add-queue p-2 w-8 h-8 flex items-center justify-center rounded-full border border-white/20 text-xs" title="加入播放列表">
                                <i class="fas fa-plus"></i>
                            </button>
                            <button type="button" class="js-add-playlist p-2 w-8 h-8 flex items-center justify-center rounded-full border border-white/20 text-xs" title="加入歌单">
                                <i class="fas fa-folder-plus"></i>
                            </button>
                        `;

                        if (song.cover) {
                            window.getCachedImage(`${song.cover}?param=80y80`).then(cachedSrc => {
                                const targetImg = document.getElementById(searchId);
                                if (targetImg) targetImg.src = cachedSrc;
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
                            if (aq) aq.onclick = function (e) {
                                e.preventDefault(); e.stopPropagation();
                                window.addSongToQueueOnly(newSong);
                                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                                self.loadPlaylist();
                            };
                            if (ap) ap.onclick = function (e) {
                                e.preventDefault(); e.stopPropagation();
                                window.openAddToPlaylistModal(newSong);
                            };
                        } catch (e) {}
                        div.onclick = () => {
                            const targetIndex = window.insertSongToPlaylist(newSong);
                            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                            this.loadPlaylist();
                            if (typeof window.playSongAtIndex === 'function') window.playSongAtIndex(targetIndex);
                            this.closeSheet();
                            showToast('已添加并播放: ' + song.name);
                        };
                        container.appendChild(div);
                    });

                } catch (e) {
                    console.error('Search failed', e);
                    container.innerHTML = '<div class="p-4 text-center opacity-50 text-xs text-red-400">搜索出错</div>';
                }
            }

            handleResize() {
                const isNowMobile = window.innerWidth < 768;
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

                    const desktopQuality = document.getElementById('qualityBadge');
                    if (this.dom.qualityBadge && desktopQuality) {
                        this.dom.qualityBadge.innerHTML = desktopQuality.innerHTML;
                        this.dom.qualityBadge.className = desktopQuality.className;
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
                if (this.dom.currentTime) this.dom.currentTime.textContent = formatTime(currentTime);
                if (this.dom.duration) this.dom.duration.textContent = formatTime(duration);
                if (this.dom.progressBar) this.dom.progressBar.style.width = `${progressPercent}%`;
            }
        }

        // Global Instance
        let mobileUI = null;

        // ================= ★ FluidBackground (复制 aura-music WebGL) =================
        class FluidBackground {
            constructor(canvasId) {
                this.canvas = document.getElementById(canvasId);
                if (!this.canvas) return;

                this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
                if (!this.gl) {
                    console.warn('WebGL 不支持');
                    return;
                }

                this.isPlaying = true;
                this.timeAccumulator = 0;
                this.lastFrameTime = performance.now();

                // 默认颜色 (aura-music)
                this.colors = [
                    'rgb(60, 20, 80)',
                    'rgb(100, 40, 60)',
                    'rgb(20, 20, 40)',
                    'rgb(40, 40, 90)'
                ];

                this.initShader();
                this.resize();
                this.animate();
                window.addEventListener('resize', () => this.resize());
            }

            parseColor(colorStr) {
                const match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                if (!match) return [0, 0, 0];
                return [parseInt(match[1], 10) / 255, parseInt(match[2], 10) / 255, parseInt(match[3], 10) / 255];
            }

            initShader() {
                const gl = this.gl;
                const vs = `attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
                const fs = `
                    precision highp float;
                    uniform vec2 uResolution; uniform float uTime;
                    uniform vec3 uColor1, uColor2, uColor3, uColor4;
                    #define S(a,b,t) smoothstep(a,b,t)
                    mat2 Rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
                    vec2 hash(vec2 p) { p = vec2(dot(p, vec2(2127.1, 81.17)), dot(p, vec2(1269.5, 283.37))); return fract(sin(p) * 43758.5453); }
                    float noise(vec2 p) {
                        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
                        float n = mix(mix(dot(-1.0 + 2.0 * hash(i), f), dot(-1.0 + 2.0 * hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
                                      mix(dot(-1.0 + 2.0 * hash(i + vec2(0,1)), f - vec2(0,1)), dot(-1.0 + 2.0 * hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
                        return 0.5 + 0.5 * n;
                    }
                    void main() {
                        vec2 uv = gl_FragCoord.xy / uResolution.xy;
                        float ratio = uResolution.x / uResolution.y;
                        vec2 tuv = uv - 0.5;
                        float degree = noise(vec2(uTime * 0.1, tuv.x * tuv.y));
                        tuv.y *= 1.0 / ratio;
                        tuv *= Rot(radians((degree - 0.5) * 720.0 + 180.0));
                        tuv.y *= ratio;
                        float frequency = 5.0, amplitude = 30.0, speed = uTime * 2.0;
                        tuv.x += sin(tuv.y * frequency + speed) / amplitude;
                        tuv.y += sin(tuv.x * frequency * 1.5 + speed) / (amplitude * 0.5);
                        vec3 layer1 = mix(uColor1, uColor2, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
                        vec3 layer2 = mix(uColor3, uColor4, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
                        gl_FragColor = vec4(mix(layer1, layer2, S(0.5, -0.3, tuv.y)), 1.0);
                    }
                `;
                const createShader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
                const vShader = createShader(gl.VERTEX_SHADER, vs), fShader = createShader(gl.FRAGMENT_SHADER, fs);
                if (!vShader || !fShader) return;
                this.program = gl.createProgram();
                gl.attachShader(this.program, vShader); gl.attachShader(this.program, fShader);
                gl.linkProgram(this.program); gl.useProgram(this.program);
                const posBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
                const posLoc = gl.getAttribLocation(this.program, 'position');
                gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
                this.uResolution = gl.getUniformLocation(this.program, 'uResolution');
                this.uTime = gl.getUniformLocation(this.program, 'uTime');
                this.uColor1 = gl.getUniformLocation(this.program, 'uColor1');
                this.uColor2 = gl.getUniformLocation(this.program, 'uColor2');
                this.uColor3 = gl.getUniformLocation(this.program, 'uColor3');
                this.uColor4 = gl.getUniformLocation(this.program, 'uColor4');
            }

            resize() { if (!this.gl) return; this.canvas.width = window.innerWidth; this.canvas.height = window.innerHeight; this.gl.viewport(0, 0, this.canvas.width, this.canvas.height); }

            async extractColorsFromImage(imgUrl) {
                try {
                    // console.log('🎨 开始从封面提取颜色:', imgUrl);
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.src = imgUrl;

                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        setTimeout(reject, 5000); // 5秒超时
                    });

                    if (typeof ColorThief !== 'undefined') {
                        const colorThief = new ColorThief();
                        const palette = colorThief.getPalette(img, 4);
                        // console.log('🎨 ColorThief 提取的调色板:', palette);

                        if (palette && palette.length >= 4) {
                            // 确保格式正确：rgb(r, g, b) 带空格
                            this.colors = palette.map(([r, g, b]) => {
                                const factor = 0.8;
                                const nr = Math.round(r * factor);
                                const ng = Math.round(g * factor);
                                const nb = Math.round(b * factor);
                                return `rgb(${nr}, ${ng}, ${nb})`;
                            });
                            console.log('🎨 更新后的背景颜色:', this.colors);
                            return;
                        }
                    } else {
                        console.warn('⚠️ ColorThief 未加载');
                    }

                    // 降级：简单采样四个角落的颜色
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = 2;
                    canvas.height = 2;
                    ctx.drawImage(img, 0, 0, 2, 2);
                    const data = ctx.getImageData(0, 0, 2, 2).data;

                    this.colors = [
                        `rgb(${Math.round(data[0] * 0.8)}, ${Math.round(data[1] * 0.8)}, ${Math.round(data[2] * 0.8)})`,
                        `rgb(${Math.round(data[4] * 0.8)}, ${Math.round(data[5] * 0.8)}, ${Math.round(data[6] * 0.8)})`,
                        `rgb(${Math.round(data[8] * 0.8)}, ${Math.round(data[9] * 0.8)}, ${Math.round(data[10] * 0.8)})`,
                        `rgb(${Math.round(data[12] * 0.8)}, ${Math.round(data[13] * 0.8)}, ${Math.round(data[14] * 0.8)})`
                    ];
                    console.log('🎨 降级采样的背景颜色:', this.colors);
                } catch (e) {
                    console.warn('❌ 颜色提取失败:', e);
                }
            }

            render() {
                if (!this.gl || !this.program) return;
                const gl = this.gl, now = performance.now(), delta = now - this.lastFrameTime;
                this.lastFrameTime = now;
                if (this.isPlaying) this.timeAccumulator += delta;
                gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                gl.useProgram(this.program);
                gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
                gl.uniform1f(this.uTime, this.timeAccumulator * 0.0005);
                const [c1, c2, c3, c4] = this.colors.map(c => this.parseColor(c));
                gl.uniform3f(this.uColor1, c1[0], c1[1], c1[2]);
                gl.uniform3f(this.uColor2, c2[0], c2[1], c2[2]);
                gl.uniform3f(this.uColor3, c3[0], c3[1], c3[2]);
                gl.uniform3f(this.uColor4, c4[0], c4[1], c4[2]);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }

            animate() { this.render(); requestAnimationFrame(() => this.animate()); }
            setPlaying(p) { this.isPlaying = p; }
            setColors(c) { if (c && c.length >= 4) this.colors = c; }
        }

        // ================= ★ Canvas 歌词渲染器 (参考 aura-music 效果) =================
        class LyricsCanvasRenderer {
            constructor(canvasId) {
                this.canvas = document.getElementById(canvasId);
                if (!this.canvas) return;

                this.ctx = this.canvas.getContext('2d');
                this.pixelRatio = window.devicePixelRatio || 1;
                this.lines = [];
                this.activeIndex = -1;
                this.scrollY = 0;
                this.targetScrollY = 0;
                this.scrollVelocity = 0;
                this.isDragging = false;
                this.lastTouchY = 0;
                this.lastInteractionTime = 0;
                this.isAnimating = false;

                this.resize();
                this.bindEvents();

                window.addEventListener('resize', () => this.resize());
            }

            resize() {
                if (!this.canvas) return;
                const rect = this.canvas.parentElement.getBoundingClientRect();
                this.width = rect.width;
                this.height = rect.height;
                this.canvas.width = this.width * this.pixelRatio;
                this.canvas.height = this.height * this.pixelRatio;
                this.canvas.style.width = this.width + 'px';
                this.canvas.style.height = this.height + 'px';
                this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
            }

            bindEvents() {
                // 鼠标/触摸交互
                this.canvas.addEventListener('mousedown', e => this.onPointerDown(e.clientY));
                this.canvas.addEventListener('mousemove', e => this.onPointerMove(e.clientY));
                this.canvas.addEventListener('mouseup', () => this.onPointerUp());
                this.canvas.addEventListener('mouseleave', () => this.onPointerUp());

                this.canvas.addEventListener('touchstart', e => {
                    e.preventDefault();
                    this.onPointerDown(e.touches[0].clientY);
                }, { passive: false });
                this.canvas.addEventListener('touchmove', e => {
                    e.preventDefault();
                    this.onPointerMove(e.touches[0].clientY);
                }, { passive: false });
                this.canvas.addEventListener('touchend', () => this.onPointerUp());

                // 鼠标滚轮
                this.canvas.addEventListener('wheel', e => {
                    e.preventDefault();
                    this.lastInteractionTime = performance.now();
                    this.targetScrollY += e.deltaY * 0.5;
                    this.clampScroll();
                }, { passive: false });

                // 点击跳转
                this.canvas.addEventListener('click', e => {
                    if (this.isDragging) return;
                    const rect = this.canvas.getBoundingClientRect();
                    const clickY = e.clientY - rect.top;
                    this.handleClick(clickY);
                });
            }

            onPointerDown(y) {
                this.isDragging = true;
                this.lastTouchY = y;
                this.scrollVelocity = 0;
                this.lastInteractionTime = performance.now();
            }

            onPointerMove(y) {
                if (!this.isDragging) return;
                const dy = this.lastTouchY - y;
                this.scrollVelocity = dy * 60;
                this.targetScrollY += dy;
                this.lastTouchY = y;
                this.clampScroll();
            }

            onPointerUp() {
                this.isDragging = false;
                this.lastInteractionTime = performance.now();
            }

            clampScroll() {
                const totalHeight = this.lines.reduce((sum, l) => sum + l.height + 16, 0);
                const maxScroll = Math.max(0, totalHeight - this.height * 0.5);
                this.targetScrollY = Math.max(-this.height * 0.3, Math.min(maxScroll, this.targetScrollY));
            }

            handleClick(clickY) {
                const focalY = this.height * 0.35;
                let y = focalY - this.scrollY;

                for (let i = 0; i < this.lines.length; i++) {
                    const line = this.lines[i];
                    const lineBottom = y + line.height;

                    if (clickY >= y && clickY <= lineBottom) {
                        // 点击跳转播放
                        audio.currentTime = line.time;
                        audio.play();
                        break;
                    }
                    y = lineBottom + 16;
                }
            }

            setLyrics(parsedLyrics) {
                this.lines = parsedLyrics.map((item, idx) => ({
                    time: item.time,
                    text: item.text,
                    words: [],
                    translation: item.html?.includes('lyric-trans')
                        ? item.html.match(/<div class="lyric-trans">(.*?)<\/div>/)?.[1]
                        : null,
                    height: 0,  // 动态计算
                    measured: false
                }));

                this.measureLines();
                this.scrollY = -this.height * 0.3;
                this.targetScrollY = this.scrollY;
                this.activeIndex = -1;

                if (!this.isAnimating) {
                    this.isAnimating = true;
                    this.animate();
                }
            }

            measureLines() {
                const ctx = this.ctx;
                const isMobile = this.width < 768; // Match aura-music breakpoint
                // ★ 字体配置 (aura-music)
                const baseSize = isMobile ? 32 : 40;
                const transSize = isMobile ? 18 : 22;
                const mainFont = `800 ${baseSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
                const transFont = `500 ${transSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
                this.paddingX = isMobile ? 24 : 56; // 增加边距
                const maxWidth = this.width - this.paddingX * 2;

                this.lines.forEach(line => {
                    ctx.font = mainFont;
                    const mainMetrics = ctx.measureText(line.text || '');
                    const mainWidth = mainMetrics.width;
                    const mainLines = Math.ceil(mainWidth / maxWidth);
                    const mainHeight = mainLines * (baseSize * 1.35); // line-height 1.35

                    let transHeight = 0;
                    if (line.translation) {
                        ctx.font = transFont;
                        const transMetrics = ctx.measureText(line.translation);
                        const transLines = Math.ceil(transMetrics.width / maxWidth);
                        transHeight = transLines * (transSize * 1.3) + 8; // margin-top 8
                    }

                    line.height = mainHeight + transHeight + 20; // margin-bottom 20
                    line.measured = true;
                });
            }

            update(currentTime) {
                if (!this.lines.length) return;

                // 找当前行
                let newActive = 0;
                for (let i = 0; i < this.lines.length; i++) {
                    if (this.lines[i].time <= currentTime + 0.2) { // Slightly fast anticipation
                        newActive = i;
                    } else {
                        break;
                    }
                }

                // 更新滚动目标
                const userScrolling = performance.now() - this.lastInteractionTime < 3000;
                if (!userScrolling && !this.isDragging) {
                    // 计算目标行位置
                    let targetY = 0;
                    for (let i = 0; i < newActive; i++) {
                        targetY += this.lines[i].height;
                    }
                    targetY += this.lines[newActive]?.height * 0.5 || 0;
                    this.targetScrollY = targetY;
                }

                this.activeIndex = newActive;

                // ★ 弹簧物理滚动 (aura-music 参数)
                // Stiffness: 120 (loose) -> 300-400 (snap)
                // Damping: 20 -> 35-40
                const stiffness = this.isDragging ? 0 : (userScrolling ? 150 : 350);
                const damping = this.isDragging ? 10 : 35;
                const dt = 1 / 60;

                const displacement = this.scrollY - this.targetScrollY;
                const springForce = -stiffness * displacement;
                const dampingForce = -damping * this.scrollVelocity;
                const acceleration = springForce + dampingForce;

                this.scrollVelocity += acceleration * dt;
                this.scrollY += this.scrollVelocity * dt;

                if (Math.abs(this.scrollVelocity) < 0.1 && Math.abs(displacement) < 0.5) {
                    this.scrollY = this.targetScrollY;
                    this.scrollVelocity = 0;
                }
            }

            render(currentTime) {
                const ctx = this.ctx;
                ctx.clearRect(0, 0, this.width, this.height);

                if (!this.lines.length) {
                    ctx.fillStyle = 'rgba(255,255,255,0.4)';
                    ctx.font = '800 24px "PingFang SC", sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('♪ 播放音乐以查看歌词', this.width / 2, this.height / 2);
                    return;
                }

                const isMobile = this.width < 768;
                const baseSize = isMobile ? 32 : 40;
                const transSize = isMobile ? 18 : 22;
                const mainFont = `800 ${baseSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;
                const transFont = `500 ${transSize}px "PingFang SC", "Noto Sans SC", "Inter", sans-serif`;

                // Focal Point: 35% from top (desktop) or near center?
                // aura-music uses 0.35 (ish)
                const focalY = this.height * 0.35;

                let y = focalY - this.scrollY;

                for (let i = 0; i < this.lines.length; i++) {
                    const line = this.lines[i];
                    const lineBottom = y + line.height;

                    // 视口裁剪
                    if (lineBottom < -100 || y > this.height + 100) {
                        y = lineBottom; // Note: margin included in line.height now
                        continue;
                    }

                    const isActive = i === this.activeIndex;

                    // 渐变与模糊逻辑
                    const distFromFocal = Math.abs(y + line.height / 2 - focalY);
                    const normDist = Math.min(distFromFocal / (this.height * 0.5), 1);

                    // aura-music opacity logic
                    let opacity = isActive ? 1 : 0.3 + (0.7 * (1 - Math.pow(normDist, 0.5))) * 0.2;
                    // Simplified: Active 1.0, others 0.3 dim
                    if (!isActive) opacity = 0.3; // Stricter contrast like aura-music

                    ctx.save();
                    ctx.globalAlpha = opacity;

                    // 缩放效果 (aura-music: Active 1.03, others 1.0)
                    const scale = isActive ? 1.03 : 1.0;

                    // Center of the line for scaling (vertically), but left aligned horizontally
                    const centerY = y + line.height / 2;
                    // Translate to paddingX, centerY
                    ctx.translate(this.paddingX, centerY);
                    ctx.scale(scale, scale);
                    // Translate back up to top-left of text block (relative to center)
                    ctx.translate(0, -line.height / 2);

                    // 渲染主歌词
                    ctx.font = mainFont;
                    ctx.textBaseline = 'top';
                    ctx.textAlign = 'left'; // 明确左对齐

                    // aura-music: Active White, Inactive White (opacity handles dimming usually, or explicit color)
                    // Inactiv color is rgba(255,255,255,0.85) but with opacity 0.3 applied globally
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillText(line.text, 0, 0);

                    // 渲染翻译
                    if (line.translation) {
                        ctx.font = transFont;
                        ctx.fillStyle = 'rgba(255,255,255,0.6)';
                        ctx.fillText(line.translation, 0, baseSize * 1.35 + 8);
                    }

                    ctx.restore();

                    y = lineBottom;
                }

                // 顶部/底部渐隐遮罩
                this.drawMask(ctx);
            }



            drawMask(ctx) {
                // 顶部渐隐
                const topGradient = ctx.createLinearGradient(0, 0, 0, this.height * 0.15);
                topGradient.addColorStop(0, 'rgba(0,0,0,1)');
                topGradient.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillStyle = topGradient;
                ctx.fillRect(0, 0, this.width, this.height * 0.15);

                // 底部渐隐
                const bottomGradient = ctx.createLinearGradient(0, this.height * 0.85, 0, this.height);
                bottomGradient.addColorStop(0, 'rgba(0,0,0,0)');
                bottomGradient.addColorStop(1, 'rgba(0,0,0,1)');
                ctx.fillStyle = bottomGradient;
                ctx.fillRect(0, this.height * 0.85, this.width, this.height * 0.15);

                ctx.globalCompositeOperation = 'source-over';
            }

            animate() {
                if (!this.isAnimating) return;

                const time = audio?.currentTime || 0;
                this.update(time);
                this.render(time);

                requestAnimationFrame(() => this.animate());
            }

            stop() {
                this.isAnimating = false;
            }
        }

        // ★ 全局实例
        let fluidBg = null;
        let lyricsCanvas = null;

        // 初始化渲染器
        function initCanvasRenderers() {
            // 流体背景
            fluidBg = new FluidBackground('fluidBg');

            // Canvas 歌词
            lyricsCanvas = new LyricsCanvasRenderer('lyricsCanvas');

            // ★ Mobile UI
            mobileUI = new MobileUIManager();
        }

        // 在 DOMContentLoaded 后初始化
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initCanvasRenderers, 100);
        });

        // updateLyrics 更新由 Canvas 的 animate 循环自动处理

        // 当封面变化时更新背景颜色
        function updateBackgroundFromCover(coverUrl) {
            if (fluidBg && coverUrl) {
                fluidBg.extractColorsFromImage(coverUrl);
            }
        }

    