from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- 1) Playlist detail modal HTML ----------
if 'id="playlistDetailModal"' not in c:
    detail = '''
    <div id="playlistDetailModal" class="fixed inset-0 hidden" style="z-index:2147483000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);">
      <div style="background:#1a1a1f;color:#fff;border-radius:16px;max-width:520px;width:94%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.15);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.1);">
          <b id="playlistDetailTitle">歌单</b>
          <button id="closePlaylistDetailModal" type="button" style="background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;">×</button>
        </div>
        <div style="display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1);flex-wrap:wrap;">
          <button id="playlistDetailPlayBtn" type="button" style="padding:8px 12px;border-radius:10px;border:0;background:#fff;color:#000;cursor:pointer;">播放整单</button>
          <button id="playlistDetailAddAllBtn" type="button" style="padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;cursor:pointer;">全部加入播放列表</button>
        </div>
        <div id="playlistDetailList" style="flex:1;overflow:auto;padding:8px 12px;"></div>
      </div>
    </div>
'''
    m = re.search(r"<body[^>]*>", c)
    c = c[:m.end()] + "\n" + detail + c[m.end():]
    print("detail modal html added")

# ---------- 2) Core helpers ----------
helpers = r'''
        // ===== Playlist detail + recent history + export/import =====
        let currentDetailPlaylistId = null;

        async function openPlaylistDetailModal(playlistId) {
            currentDetailPlaylistId = playlistId;
            const modal = document.getElementById('playlistDetailModal');
            if (!modal) return;
            modal.classList.remove('hidden');
            modal.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
            await refreshPlaylistDetailList();
        }
        window.openPlaylistDetailModal = openPlaylistDetailModal;

        function closePlaylistDetailModal() {
            const modal = document.getElementById('playlistDetailModal');
            if (!modal) return;
            modal.style.display = 'none';
            modal.classList.add('hidden');
            currentDetailPlaylistId = null;
        }
        window.closePlaylistDetailModal = closePlaylistDetailModal;

        async function refreshPlaylistDetailList() {
            const box = document.getElementById('playlistDetailList');
            const title = document.getElementById('playlistDetailTitle');
            if (!box || !currentDetailPlaylistId) return;
            const list = await listUserPlaylists();
            const pl = list.find(function (x) { return x.id === currentDetailPlaylistId; });
            if (!pl) {
                box.innerHTML = '<div class="p-3 text-sm opacity-50">歌单不存在</div>';
                return;
            }
            if (title) title.textContent = pl.name + '（' + pl.songs.length + ' 首）';
            if (!pl.songs.length) {
                box.innerHTML = '<div class="p-3 text-sm opacity-50 text-center">歌单为空，去搜索结果点「歌单」加入</div>';
                return;
            }
            box.innerHTML = '';
            pl.songs.forEach(function (song, idx) {
                const row = document.createElement('div');
                row.className = 'flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 mb-1';
                const cover = song.cover ? ('<img src="' + song.cover + '?param=60y60" style="width:36px;height:36px;border-radius:8px;object-fit:cover;" loading="lazy">') : '<div style="width:36px;height:36px;border-radius:8px;background:rgba(255,255,255,.08);"></div>';
                row.innerHTML = '<div style="flex:none">' + cover + '</div>' +
                    '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(song.name) + '</div>' +
                    '<div style="font-size:12px;opacity:.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(song.artist || '') + '</div></div>' +
                    '<button type="button" data-act="play" style="flex:none;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;font-size:12px;cursor:pointer;">播放</button>' +
                    '<button type="button" data-act="del" style="flex:none;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,0,0,.3);background:rgba(255,0,0,.1);color:#ffb0b0;font-size:12px;cursor:pointer;">删</button>';
                row.querySelector('[data-act="play"]').onclick = function () {
                    const targetIndex = window.insertSongToPlaylist(normalizeSongObject(song));
                    if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                    if (typeof window.playSongAtIndex === 'function') window.playSongAtIndex(targetIndex);
                    closePlaylistDetailModal();
                };
                row.querySelector('[data-act="del"]').onclick = async function () {
                    if (!confirm('从歌单移除「' + song.name + '」？')) return;
                    pl.songs.splice(idx, 1);
                    await saveUserPlaylistRecord(pl);
                    await refreshPlaylistDetailList();
                    await refreshUserPlaylistLibrary();
                };
                box.appendChild(row);
            });
        }

        async function playEntirePlaylist() {
            if (!currentDetailPlaylistId) return;
            await loadUserPlaylistIntoQueue(currentDetailPlaylistId, true);
            closePlaylistDetailModal();
        }

        async function addAllToQueue() {
            if (!currentDetailPlaylistId) return;
            const list = await listUserPlaylists();
            const pl = list.find(function (x) { return x.id === currentDetailPlaylistId; });
            if (!pl || !pl.songs.length) return;
            let added = 0;
            pl.songs.forEach(function (song) {
                const idx = window.addSongToQueueOnly(song, { toast: false, allowDuplicate: false });
                if (idx >= 0) added++;
            });
            if (typeof showToast === 'function') showToast('已加入 ' + added + ' 首到播放列表');
            closePlaylistDetailModal();
        }

        // ===== Recent history =====
        const RECENT_KEY = 'cp_recent_history';
        const RECENT_MAX = 50;

        function getRecentHistory() {
            try {
                return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
            } catch (e) {
                return [];
            }
        }

        function pushRecentHistory(song) {
            try {
                const norm = normalizeSongObject(song);
                if (!norm) return;
                let list = getRecentHistory();
                list = list.filter(function (x) { return String(x.id) !== String(norm.id); });
                list.unshift({
                    id: norm.id,
                    name: norm.name,
                    artist: norm.artist,
                    cover: norm.cover,
                    timestamp: Date.now()
                });
                if (list.length > RECENT_MAX) list = list.slice(0, RECENT_MAX);
                localStorage.setItem(RECENT_KEY, JSON.stringify(list));
            } catch (e) {
                console.warn('[history] save failed', e);
            }
        }

        function clearRecentHistory() {
            localStorage.removeItem(RECENT_KEY);
        }

        async function renderRecentHistory() {
            const box = document.getElementById('recentHistoryList');
            if (!box) return;
            const list = getRecentHistory();
            if (!list.length) {
                box.innerHTML = '<div class="text-xs opacity-50 py-2">暂无最近播放</div>';
                return;
            }
            box.innerHTML = '';
            list.slice(0, 20).forEach(function (song) {
                const row = document.createElement('div');
                row.className = 'flex items-center gap-2 p-2 rounded-xl hover:bg-white/5 cursor-pointer';
                row.innerHTML = '<div style="flex:1;min-width:0"><div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(song.name) + '</div><div style="font-size:11px;opacity:.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(song.artist || '') + '</div></div><span style="font-size:11px;opacity:.4;flex:none;">▶</span>';
                row.onclick = function () {
                    const targetIndex = window.insertSongToPlaylist(normalizeSongObject(song));
                    if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                    if (typeof window.playSongAtIndex === 'function') window.playSongAtIndex(targetIndex);
                };
                box.appendChild(row);
            });
        }

        // ===== Export / Import playlists =====
        async function exportUserPlaylists() {
            const list = await listUserPlaylists();
            const data = {
                version: 1,
                exportedAt: new Date().toISOString(),
                playlists: list.map(function (pl) {
                    return {
                        name: pl.name,
                        songs: pl.songs
                    };
                })
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'cplayer-playlists-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            if (typeof showToast === 'function') showToast('已导出 ' + list.length + ' 个歌单');
        }

        async function importUserPlaylists(file) {
            return new Promise(function (resolve, reject) {
                const reader = new FileReader();
                reader.onload = async function (e) {
                    try {
                        const data = JSON.parse(e.target.result);
                        if (!data.playlists || !Array.isArray(data.playlists)) {
                            throw new Error('格式不正确');
                        }
                        let imported = 0;
                        for (const pl of data.playlists) {
                            if (!pl.name || !Array.isArray(pl.songs)) continue;
                            await saveUserPlaylistRecord({
                                id: USER_PL_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                                name: pl.name,
                                songs: pl.songs
                            });
                            imported++;
                        }
                        resolve(imported);
                    } catch (err) {
                        reject(err);
                    }
                };
                reader.onerror = function () { reject(reader.error); };
                reader.readAsText(file);
            });
        }

'''
# Insert helpers before bindUserPlaylistUI function
insert_at = c.find("function bindUserPlaylistUI")
if insert_at < 0:
    raise SystemExit("bindUserPlaylistUI missing")
c = c[:insert_at] + helpers + c[insert_at:]
print("helpers inserted")

# ---------- 3) Library: add detail button ----------
old_lib = '''                    row.innerHTML = '<div class="flex-1 min-w-0"><div class="text-sm font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-[11px] opacity-50">' + pl.songs.length + ' 首</div></div><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="load">播放</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="del">删除</button>';'''
new_lib = '''                    row.innerHTML = '<div class="flex-1 min-w-0"><div class="text-sm font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-[11px] opacity-50">' + pl.songs.length + ' 首</div></div><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="detail">管理</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="load">播放</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="del">删除</button>';'''
if old_lib in c:
    c = c.replace(old_lib, new_lib)
    print("library detail button added")

old_lib_click = '''                    row.querySelector('[data-act="load"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id, true); };'''
new_lib_click = '''                    row.querySelector('[data-act="detail"]').onclick = function () { openPlaylistDetailModal(pl.id); };
                    row.querySelector('[data-act="load"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id, true); };'''
if old_lib_click in c:
    c = c.replace(old_lib_click, new_lib_click)
    print("library detail click added")

# ---------- 4) History hook in loadAndPlaySong ----------
# Find successful play and push history
# Look for: dom.songTitle.textContent = data.name
old_play = "dom.songTitle.textContent = data.name || '未知歌曲';"
new_play = """dom.songTitle.textContent = data.name || '未知歌曲';
                try { if (typeof pushRecentHistory === 'function') pushRecentHistory({ id: data.id, name: data.name, artist: data.artist, cover: data.cover }); } catch (e) {}"""
if old_play in c:
    c = c.replace(old_play, new_play, 1)
    print("history hook added")

# ---------- 5) Settings UI: add recent history + export/import section ----------
settings_section = '''
                    <div class="mt-5 p-4 rounded-2xl border border-white/10 bg-white/[0.04]">
                        <div class="text-sm font-medium mb-2">最近播放</div>
                        <div id="recentHistoryList" class="max-h-48 overflow-y-auto mb-2"></div>
                        <div class="flex gap-2">
                            <button id="clearRecentBtn" type="button" class="px-3 py-1.5 rounded-lg bg-white/10 text-xs">清空历史</button>
                        </div>
                    </div>
                    <div class="mt-4 p-4 rounded-2xl border border-white/10 bg-white/[0.04]">
                        <div class="text-sm font-medium mb-2">歌单备份</div>
                        <div class="flex gap-2">
                            <button id="exportPlaylistsBtn" type="button" class="px-3 py-1.5 rounded-lg bg-white/10 text-xs">导出歌单 JSON</button>
                            <label class="px-3 py-1.5 rounded-lg bg-white/10 text-xs cursor-pointer">
                                导入
                                <input id="importPlaylistsInput" type="file" accept=".json" class="hidden">
                            </label>
                        </div>
                        <p class="text-[11px] opacity-40 mt-2">导出后可保存到手机/电脑；换浏览器或清数据后可重新导入。</p>
                    </div>
'''
# Insert after userPlaylistLibrary section
lib_marker = 'id="userPlaylistLibrary"'
lib_pos = c.find(lib_marker)
if lib_pos > 0:
    # find end of that container div
    # look for closing of the mt-5 container after library
    # simpler: insert after the library div's parent closes
    # find: </div> after the library div's closing </div>
    # the library container ends with: <div id="userPlaylistLibrary" ...></div>\n<p ...>...</p>\n                    </div>
    # find the closing </div> after the <p> tag
    p_end = c.find("</div>", lib_pos)
    # actually find the container end - look for the text after library
    text_after = "这里可管理并一键播放歌单"
    t_pos = c.find(text_after, lib_pos)
    if t_pos > 0:
        # find closing </div> after this text
        close_div = c.find("</div>", t_pos)
        if close_div > 0:
            c = c[:close_div + 6] + "\n" + settings_section + c[close_div + 6:]
            print("settings section added")
        else:
            print("WARN settings insert point not found")

# ---------- 6) Bind new buttons in bindUserPlaylistUI ----------
# Add to the global click delegation
old_delegate_end = """                if (t.closest('#closeUserPlaylistModal')) {
                    e.preventDefault();
                    closeAddToPlaylistModal();
                    return;
                }"""
new_delegate_end = """                if (t.closest('#closeUserPlaylistModal')) {
                    e.preventDefault();
                    closeAddToPlaylistModal();
                    return;
                }
                if (t.closest('#closePlaylistDetailModal')) {
                    e.preventDefault();
                    closePlaylistDetailModal();
                    return;
                }
                if (t.closest('#playlistDetailPlayBtn')) {
                    e.preventDefault();
                    playEntirePlaylist();
                    return;
                }
                if (t.closest('#playlistDetailAddAllBtn')) {
                    e.preventDefault();
                    addAllToQueue();
                    return;
                }
                if (t.closest('#clearRecentBtn')) {
                    e.preventDefault();
                    if (!confirm('清空最近播放历史？')) return;
                    clearRecentHistory();
                    renderRecentHistory();
                    if (typeof showToast === 'function') showToast('已清空');
                    return;
                }
                if (t.closest('#exportPlaylistsBtn')) {
                    e.preventDefault();
                    exportUserPlaylists();
                    return;
                }"""
if old_delegate_end in c:
    c = c.replace(old_delegate_end, new_delegate_end)
    print("delegate updated")

# Bind import file input
old_bind_end = """            refreshUserPlaylistLibrary();
        }
        window.bindUserPlaylistUI = bindUserPlaylistUI;"""
new_bind_end = """            // Import file input
            const importInput = document.getElementById('importPlaylistsInput');
            if (importInput) {
                importInput.addEventListener('change', async function (e) {
                    const file = e.target.files && e.target.files[0];
                    if (!file) return;
                    try {
                        const count = await importUserPlaylists(file);
                        if (typeof showToast === 'function') showToast('已导入 ' + count + ' 个歌单');
                        await refreshUserPlaylistLibrary();
                    } catch (err) {
                        console.error(err);
                        if (typeof showToast === 'function') showToast('导入失败: ' + (err.message || err), true);
                    }
                    importInput.value = '';
                });
            }
            refreshUserPlaylistLibrary();
            renderRecentHistory();
        }
        window.bindUserPlaylistUI = bindUserPlaylistUI;"""
if old_bind_end in c:
    c = c.replace(old_bind_end, new_bind_end)
    print("import input bound")

# ---------- 7) openSettings: render recent history ----------
old_open_settings = "function openSettings() {"
if old_open_settings in c and "renderRecentHistory" not in c[c.find(old_open_settings):c.find(old_open_settings)+400]:
    c = c.replace(
        old_open_settings,
        "function openSettings() {\n            try { if (typeof renderRecentHistory === 'function') renderRecentHistory(); } catch (e) {}",
        1,
    )
    print("openSettings renders history")

# ---------- 8) SW bump ----------
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v24-detail-history'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("detail modal", "playlistDetailModal" in c)
print("history", "pushRecentHistory" in c)
print("export", "exportUserPlaylists" in c)
print("import", "importUserPlaylists" in c)
