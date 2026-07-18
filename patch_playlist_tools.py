from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- 1) Recent plays ----------
recent_fn = '''
        const RECENT_KEY = 'cplayer_recent_plays';
        function loadRecentPlays() {
            try {
                const raw = localStorage.getItem(RECENT_KEY);
                if (!raw) return [];
                const arr = JSON.parse(raw);
                return Array.isArray(arr) ? arr : [];
            } catch (e) { return []; }
        }
        function saveRecentPlays(list) {
            try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) {}
        }
        function pushRecentPlay(song) {
            try {
                const norm = normalizeSongObject(song);
                if (!norm || !norm.id) return;
                const list = loadRecentPlays();
                const idx = list.findIndex(s => String(s.id) === String(norm.id) && s.source === norm.source);
                if (idx >= 0) list.splice(idx, 1);
                list.unshift({ ...norm, playedAt: Date.now() });
                saveRecentPlays(list);
                renderRecentPlays();
            } catch (e) { console.warn(e); }
        }
        function renderRecentPlays() {
            const box = document.getElementById('recentPlaysBox');
            if (!box) return;
            const list = loadRecentPlays();
            if (!list.length) {
                box.innerHTML = '<div class="text-xs opacity-50 py-2">暂无最近播放</div>';
                return;
            }
            box.innerHTML = '';
            list.slice(0, 12).forEach(function (s) {
                const row = document.createElement('div');
                row.className = 'flex items-center gap-2 p-2 rounded-xl bg-white/5 mb-2';
                const title = document.createElement('div');
                title.className = 'flex-1 min-w-0 text-sm truncate';
                title.textContent = (s.name || '未知') + ' - ' + (s.artist || '');
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'px-2 py-1 text-xs rounded-lg bg-white/10';
                addBtn.textContent = '加入';
                addBtn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); window.addSongToQueueOnly(s); };
                const playBtn = document.createElement('button');
                playBtn.type = 'button';
                playBtn.className = 'px-2 py-1 text-xs rounded-lg bg-white/10';
                playBtn.textContent = '播放';
                playBtn.onclick = function (e) {
                    e.preventDefault(); e.stopPropagation();
                    if (window.addSongToQueueOnly) window.addSongToQueueOnly(s);
                    const idx = playlist.findIndex(x => String(x.id) === String(s.id) && x.source === s.source);
                    if (idx >= 0) playSongAtIndex(idx);
                };
                row.appendChild(title);
                row.appendChild(addBtn);
                row.appendChild(playBtn);
                box.appendChild(row);
            });
        }
        window.renderRecentPlays = renderRecentPlays;
        window.pushRecentPlay = pushRecentPlay;
'''
anchor = "const USER_PL_PREFIX = 'user_pl_';"
i = c.find(anchor)
if i < 0:
    raise SystemExit("USER_PL_PREFIX anchor missing")
# insert after that line
line_end = c.find("\n", i)
c = c[:line_end] + "\n" + recent_fn + c[line_end:]
print("recent fns inserted")

# Insert Recent panel UI above user playlist library (same column)
ui = '''
                <div class="mb-4">
                    <div class="flex items-center justify-between mb-2">
                        <div class="text-sm opacity-70">最近播放</div>
                        <button id="clearRecentBtn" type="button" class="text-[11px] opacity-60 hover:opacity-100">清空</button>
                    </div>
                    <div id="recentPlaysBox" class="max-h-48 overflow-y-auto custom-scrollbar"></div>
                </div>
'''
lib_anchor = '<div id="userPlaylistLibrary"'
j = c.find(lib_anchor)
if j < 0:
    raise SystemExit("userPlaylistLibrary anchor missing")
# insert before its parent block start: find preceding "我的歌单" container start is tricky; insert directly before the library div parent line
# Find the line containing '<div id="userPlaylistLibrary"'
line_start = c.rfind("\n", 0, j)
c = c[:line_start] + "\n" + ui + c[line_start:]
print("recent UI inserted")

# Bind clear recent in bindUserPlaylistUI
bind_marker = "if (t.closest('#clearQueueBtn'))"
bi = c.find(bind_marker)
if bi < 0:
    raise SystemExit("clearQueueBtn bind anchor missing")
insert_before = c.rfind("}", 0, bi)  # end of previous if block? We'll instead inject new if before clearQueueBtn if.
inject = '''                if (t.closest('#clearRecentBtn')) {
                    e.preventDefault();
                    localStorage.removeItem(RECENT_KEY);
                    renderRecentPlays();
                    if (typeof showToast === 'function') showToast('已清空最近播放');
                    return;
                }
'''
c = c[:bi] + inject + c[bi:]
print("recent clear bind added")

# Record recent on successful play
play_marker = "// ★ 无缝播放：预加载下一首"
pi = c.find(play_marker)
if pi > 0:
    c = c.replace(play_marker, "try { pushRecentPlay(data); } catch (e) {}\n\n                " + play_marker, 1)
    print("recent push on play added")

# ---------- 2) Playlist detail: delete songs / play single ----------
detail_fn = '''
        window.currentDetailPlaylistId = null;
        async function openPlaylistDetail(id) {
            window.currentDetailPlaylistId = id;
            const list = await listUserPlaylists();
            const pl = list.find(p => p.id === id);
            if (!pl) return;
            const modal = document.getElementById('playlistDetailModal');
            const title = document.getElementById('playlistDetailTitle');
            const body = document.getElementById('playlistDetailBody');
            if (!modal || !body) return;
            title.textContent = pl.name + '（' + pl.songs.length + ' 首）';
            body.innerHTML = '';
            if (!pl.songs.length) {
                body.innerHTML = '<div class="p-3 text-sm opacity-50 text-center">歌单为空</div>';
            } else {
                pl.songs.forEach(function (s, idx) {
                    const row = document.createElement('div');
                    row.className = 'flex items-center gap-2 p-2 rounded-xl bg-white/5 mb-2';
                    const title = document.createElement('div');
                    title.className = 'flex-1 min-w-0 text-sm truncate';
                    title.textContent = (idx + 1) + '. ' + (s.name || '未知') + ' - ' + (s.artist || '');
                    const playBtn = document.createElement('button');
                    playBtn.type = 'button';
                    playBtn.className = 'px-2 py-1 text-xs rounded-lg bg-white/10';
                    playBtn.textContent = '播放';
                    playBtn.onclick = function (e) {
                        e.preventDefault(); e.stopPropagation();
                        if (window.addSongToQueueOnly) window.addSongToQueueOnly(s);
                        const qi = playlist.findIndex(x => String(x.id) === String(s.id) && x.source === s.source);
                        if (qi >= 0) playSongAtIndex(qi);
                    };
                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.className = 'px-2 py-1 text-xs rounded-lg bg-red-500/20 text-red-300';
                    delBtn.textContent = '删除';
                    delBtn.onclick = async function (e) {
                        e.preventDefault(); e.stopPropagation();
                        pl.songs.splice(idx, 1);
                        await saveUserPlaylistRecord(pl);
                        openPlaylistDetail(id);
                        refreshUserPlaylistLibrary();
                    };
                    row.appendChild(title);
                    row.appendChild(playBtn);
                    row.appendChild(delBtn);
                    body.appendChild(row);
                });
            }
            modal.classList.remove('hidden');
            modal.style.cssText = 'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
        }
        function closePlaylistDetail() {
            const modal = document.getElementById('playlistDetailModal');
            if (!modal) return;
            modal.style.display = 'none';
            modal.classList.add('hidden');
            window.currentDetailPlaylistId = null;
        }
        window.closePlaylistDetail = closePlaylistDetail;
'''
anchor2 = "async function loadUserPlaylistIntoQueue"
i2 = c.find(anchor2)
if i2 < 0:
    raise SystemExit("loadUserPlaylistIntoQueue anchor missing")
# insert before function start
line_start2 = c.rfind("\n", 0, i2)
c = c[:line_start2] + "\n" + detail_fn + c[line_start2:]
print("detail fns inserted")

# Detail modal HTML near userPlaylistModal
detail_html = '''
        <!-- 歌单详情（管理） -->
        <div id="playlistDetailModal" class="hidden fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
            <div class="w-[92%] max-w-md rounded-2xl bg-[#181818] border border-white/10 shadow-2xl p-4">
                <div class="flex items-center justify-between mb-3">
                    <div id="playlistDetailTitle" class="font-semibold">歌单</div>
                    <button id="closePlaylistDetailModal" type="button" class="opacity-70 hover:opacity-100 text-xl">×</button>
                </div>
                <div id="playlistDetailBody" class="max-h-80 overflow-y-auto custom-scrollbar"></div>
            </div>
        </div>
'''
um = c.find('id="userPlaylistModal"')
if um < 0:
    raise SystemExit("userPlaylistModal html missing")
# insert before its parent div start: find preceding "<div" containing userPlaylistModal
div_start = c.rfind("<div", 0, um)
c = c[:div_start] + detail_html + "\n" + c[div_start:]
print("detail modal html inserted")

# Bind manage button & close detail in bindUserPlaylistUI
bind2_marker = "if (t.closest('#clearRecentBtn'))"
b2 = c.find(bind2_marker)
if b2 < 0:
    raise SystemExit("clearRecent bind missing")
inject2 = '''                if (t.closest('#closePlaylistDetailModal')) {
                    e.preventDefault();
                    closePlaylistDetail();
                    return;
                }
'''
c = c[:b2] + inject2 + c[b2:]
print("detail close bind added")

# Change library "管理" to open detail instead of load+close
old_manage = "row.querySelector('[data-act=\"detail\"]')"
# simpler: replace whole onclick body if pattern known. We'll patch by replacing text 'openPlaylistDetail' hook by modifying library row handler.
old_detail_call = "row.querySelector('[data-act=\"detail\"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id); closePlaylistPanel(); };"
new_detail_call = "row.querySelector('[data-act=\"detail\"]').onclick = function () { openPlaylistDetail(pl.id); };"
if old_detail_call in c:
    c = c.replace(old_detail_call, new_detail_call)
    print("manage opens detail")
else:
    print("WARN manage handler pattern not found")

# ---------- 3) Export / Import user playlists ----------
export_fn = '''
        function downloadText(filename, text) {
            const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
        }
        async function exportUserPlaylists() {
            try {
                const list = await listUserPlaylists();
                const payload = { version: 1, exportedAt: Date.now(), playlists: list };
                downloadText('cplayer-playlists.json', JSON.stringify(payload, null, 2));
                if (typeof showToast === 'function') showToast('已导出歌单');
            } catch (e) {
                console.error(e);
                if (typeof showToast === 'function') showToast('导出失败', true);
            }
        }
        async function importUserPlaylistsFromFile(file) {
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const arr = Array.isArray(data) ? data : data.playlists;
                if (!Array.isArray(arr)) throw new Error('bad format');
                for (const pl of arr) {
                    if (!pl || !pl.name || !Array.isArray(pl.songs)) continue;
                    const clean = {
                        id: pl.id || (USER_PL_PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
                        name: String(pl.name),
                        songs: pl.songs.map(normalizeSongObject),
                        createdAt: pl.createdAt || Date.now()
                    };
                    await saveUserPlaylistRecord(clean);
                }
                await refreshUserPlaylistLibrary();
                if (typeof showToast === 'function') showToast('导入完成');
            } catch (e) {
                console.error(e);
                alert('导入失败，文件格式不正确');
            }
        }
'''
anchor3 = "function downloadText"
if anchor3 not in c:
    i3 = c.find("window.closeAddToPlaylistModal = closeAddToPlaylistModal;")
    if i3 < 0:
        raise SystemExit("closeAddToPlaylistModal anchor missing")
    insert_pos = c.find("\n", i3)
    c = c[:insert_pos] + "\n" + export_fn + c[insert_pos:]
    print("export/import fns inserted")

# Buttons near library header: find "我的歌单" block and add export/import buttons
header = '我的歌单'
hi = c.find(header)
if hi < 0:
    raise SystemExit("my playlists header missing")
# after header's parent row, insert controls before userPlaylistLibrary
ui2 = '''
                <div class="flex items-center gap-2 mb-2">
                    <button id="exportPlaylistsBtn" type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10">导出</button>
                    <label class="px-2 py-1 text-xs rounded-lg bg-white/10 cursor-pointer">
                        导入
                        <input id="importPlaylistsInput" type="file" accept=".json,application/json" class="hidden" />
                    </label>
                </div>
'''
# place before recent box? Place right before userPlaylistLibrary container (after header). Find the div with id userPlaylistLibrary
ulp = c.find('id="userPlaylistLibrary"')
line_start3 = c.rfind("\n", 0, ulp)
c = c[:line_start3] + "\n" + ui2 + c[line_start3:]
print("export/import UI inserted")

# Bind export/import in bindUserPlaylistUI
bind3_marker = "if (t.closest('#closePlaylistDetailModal'))"
b3 = c.find(bind3_marker)
if b3 < 0:
    raise SystemExit("detail close bind missing")
inject3 = '''                if (t.closest('#exportPlaylistsBtn')) {
                    e.preventDefault();
                    exportUserPlaylists();
                    return;
                }
'''
c = c[:b3] + inject3 + c[b3:]
print("export bind added")

# input change binding (separate listener, not via click)
bind4_marker = "function bindUserPlaylistUI"
b4 = c.find(bind4_marker)
if b4 < 0:
    raise SystemExit("bindUserPlaylistUI missing")
# insert near end before closing of bind function is tricky; use DOMContentLoaded init block? Add global listener after function definition.
init_snip = '''
        document.addEventListener('change', (e) => {
            const inp = e.target && e.target.closest && e.target.closest('#importPlaylistsInput');
            if (!inp) return;
            const f = inp.files && inp.files[0];
            if (f) importUserPlaylistsFromFile(f);
            inp.value = '';
        });
'''
# place after window.closeAddToPlaylistModal export fn area end marker
end_marker = "window.closePlaylistDetail = closePlaylistDetail;"
ei = c.find(end_marker)
if ei < 0:
    raise SystemExit("closePlaylistDetail marker missing")
pos = c.find("\n", ei)
c = c[:pos] + "\n" + init_snip + c[pos:]
print("import change listener added")

# Init render recent at startup with library refresh
boot_marker = "refreshUserPlaylistLibrary();"
# add renderRecentPlays after first occurrence of refreshUserPlaylistLibrary(); call in boot
bi2 = c.find(boot_marker)
if bi2 > 0:
    c = c.replace(boot_marker, boot_marker + "\n            if (typeof renderRecentPlays === 'function') renderRecentPlays();", 1)
    print("recent init added")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v24-playlist-tools'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("recent", "pushRecentPlay" in c, "detail", "openPlaylistDetail" in c, "export", "exportUserPlaylists" in c)
