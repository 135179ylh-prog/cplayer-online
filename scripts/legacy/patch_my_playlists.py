from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- 1) Fix playlist item "+" to NOT play, only open add-to-playlist ----------
# In mCreateItem, ensure addPlBtn handler doesn't bubble to row click
old = '''                        const addPlBtn = div.querySelector('.js-add-playlist-item');
                        if (addPlBtn) {
                            addPlBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.openAddToPlaylistModal(song);
                            };
                        }'''
new = '''                        const addPlBtn = div.querySelector('.js-add-playlist-item');
                        if (addPlBtn) {
                            addPlBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                e.stopImmediatePropagation && e.stopImmediatePropagation();
                                window.openAddToPlaylistModal(song);
                                return false;
                            };
                        }'''
if old in c:
    c = c.replace(old, new)
    print("mobile + stop propagation fixed")

# ---------- 2) My Playlists page (mobile bottom sheet style) ----------
if 'id="myPlaylistsModal"' not in c:
    modal_html = '''
        <!-- 我的歌单 -->
        <div id="myPlaylistsModal" class="hidden fixed inset-0 z-[9999] flex items-end bg-black/60">
            <div class="w-full max-h-[85vh] rounded-t-3xl bg-[#181818] border-t border-white/10 p-4 pb-8">
                <div class="flex items-center justify-between mb-3">
                    <div class="font-semibold text-lg">我的歌单</div>
                    <button id="closeMyPlaylistsBtn" type="button" class="opacity-70 text-2xl">×</button>
                </div>
                <div class="flex items-center gap-2 mb-3">
                    <input id="myNewPlaylistName" type="text" placeholder="新建歌单名称" class="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none" />
                    <button id="myCreatePlaylistBtn" type="button" class="px-4 py-2 rounded-xl bg-white/10 text-sm">新建</button>
                </div>
                <div id="myPlaylistsList" class="overflow-y-auto max-h-[55vh]"></div>
            </div>
        </div>
'''
    # insert before closing body
    idx = c.rfind("</body>")
    if idx > 0:
        c = c[:idx] + modal_html + c[idx:]
        print("my playlists modal inserted")

# ---------- 3) My playlists logic ----------
logic = '''
        async function refreshMyPlaylists() {
            const box = document.getElementById('myPlaylistsList');
            if (!box) return;
            const list = await listUserPlaylists();
            box.innerHTML = '';
            if (!list.length) {
                box.innerHTML = '<div class="p-4 text-center opacity-50 text-sm">还没有歌单，先新建一个吧</div>';
                return;
            }
            list.forEach(function (pl) {
                const row = document.createElement('div');
                row.className = 'p-3 rounded-xl bg-white/5 mb-2';
                row.innerHTML = '<div class="flex items-center justify-between mb-2"><div class="font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-xs opacity-50">' + pl.songs.length + ' 首</div></div>';
                const actions = document.createElement('div');
                actions.className = 'flex items-center gap-2';
                const playBtn = document.createElement('button');
                playBtn.type = 'button';
                playBtn.className = 'px-3 py-1.5 rounded-lg bg-white/10 text-xs';
                playBtn.textContent = '播放全部';
                playBtn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); loadUserPlaylistIntoQueue(pl.id); closeMyPlaylists(); };
                const manageBtn = document.createElement('button');
                manageBtn.type = 'button';
                manageBtn.className = 'px-3 py-1.5 rounded-lg bg-white/10 text-xs';
                manageBtn.textContent = '管理';
                manageBtn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openPlaylistDetail(pl.id); };
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 text-xs';
                delBtn.textContent = '删除';
                delBtn.onclick = async function (e) { e.preventDefault(); e.stopPropagation(); if (!confirm('删除歌单「' + pl.name + '」？')) return; await deleteUserPlaylist(pl.id); refreshMyPlaylists(); refreshUserPlaylistLibrary(); };
                actions.appendChild(playBtn);
                actions.appendChild(manageBtn);
                actions.appendChild(delBtn);
                row.appendChild(actions);
                box.appendChild(row);
            });
        }
        function openMyPlaylists() {
            const m = document.getElementById('myPlaylistsModal');
            if (!m) return;
            m.classList.remove('hidden');
            refreshMyPlaylists();
        }
        function closeMyPlaylists() {
            const m = document.getElementById('myPlaylistsModal');
            if (!m) return;
            m.classList.add('hidden');
        }
        window.openMyPlaylists = openMyPlaylists;
        window.closeMyPlaylists = closeMyPlaylists;
'''
if "async function refreshMyPlaylists" not in c:
    # insert after window.closePlaylistDetail export
    marker = "window.closePlaylistDetail = closePlaylistDetail;"
    i = c.find(marker)
    if i > 0:
        pos = c.find("\n", i)
        c = c[:pos] + "\n" + logic + c[pos:]
        print("my playlists logic inserted")

# ---------- 4) Bind my playlists UI ----------
bind_marker = "if (t.closest('#clearQueueBtn'))"
bi = c.find(bind_marker)
if bi > 0 and "myCreatePlaylistBtn" not in c[c.find("function bindUserPlaylistUI"):c.find("function bindUserPlaylistUI")+5000]:
    inject = '''                if (t.closest('#closeMyPlaylistsBtn')) {
                    e.preventDefault();
                    closeMyPlaylists();
                    return;
                }
                if (t.closest('#myCreatePlaylistBtn')) {
                    e.preventDefault();
                    const inp = document.getElementById('myNewPlaylistName');
                    const name = inp ? inp.value.trim() : '';
                    if (!name) { if (typeof showToast === 'function') showToast('请输入歌单名称', true); return; }
                    createUserPlaylist(name).then(() => { if (inp) inp.value=''; refreshMyPlaylists(); refreshUserPlaylistLibrary(); if (typeof showToast === 'function') showToast('已创建歌单'); });
                    return;
                }
                if (t.closest('#myPlaylistsBtn')) {
                    e.preventDefault();
                    openMyPlaylists();
                    return;
                }
'''
    c = c[:bi] + inject + c[bi:]
    print("my playlists bindings added")

# ---------- 5) Mobile bottom bar: add "歌单" button ----------
if 'id="myPlaylistsBtn"' not in c:
    anchor = 'id="mobilePlaylistToggleBtn"'
    i = c.find(anchor)
    if i > 0:
        line_start = c.rfind("\n", 0, i)
        c = c[:line_start] + '\n<button id="myPlaylistsBtn" type="button" class="px-4 h-11 rounded-full bg-white/10 text-sm flex items-center justify-center">歌单</button>' + c[line_start:]
        print("my playlists button inserted")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v37-my-playlists'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("my playlists", "myPlaylistsModal" in c, "btn", "myPlaylistsBtn" in c)
