from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# Add missing openMyPlaylists/closeMyPlaylists/refreshMyPlaylists functions
if "function openMyPlaylists" not in c:
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
                manageBtn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); if (window.openPlaylistDetail) openPlaylistDetail(pl.id); };
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
        window.refreshMyPlaylists = refreshMyPlaylists;
'''
    # insert before bindUserPlaylistUI
    marker = "function bindUserPlaylistUI"
    i = c.find(marker)
    if i > 0:
        line_start = c.rfind("\n", 0, i)
        c = c[:line_start] + "\n" + logic + c[line_start:]
        print("my playlists fns inserted")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v39-my-playlists-fix'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("openMyPlaylists", "function openMyPlaylists" in c)
