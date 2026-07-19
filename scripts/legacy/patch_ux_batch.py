from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- 1) Add-to-playlist modal: DO NOT auto close after add; show status & clear pending ----------
old_fn = c[c.find("function openAddToPlaylistModal"):]
old_fn = old_fn[: old_fn.find("function closeAddToPlaylistModal")]
if "openAddToPlaylistModal" not in old_fn:
    raise SystemExit("open fn not found")

new_open = '''function openAddToPlaylistModal(song) {
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

'''
# replace from function openAddToPlaylistModal through window.closeAddToPlaylistModal = closeAddToPlaylistModal;
start = c.find("function openAddToPlaylistModal")
end = c.find("window.closeAddToPlaylistModal = closeAddToPlaylistModal;")
if start < 0 or end < 0:
    raise SystemExit("open/close anchors missing")
end = end + len("window.closeAddToPlaylistModal = closeAddToPlaylistModal;")
c = c[:start] + new_open + c[end:]

# refreshUserPlaylistModalList: do not close modal after add; show inline status and allow multiple adds
old_refresh = c[c.find("async function refreshUserPlaylistModalList"):]
old_refresh = old_refresh[: old_refresh.find("async function refreshUserPlaylistLibrary")]
new_refresh = '''async function refreshUserPlaylistModalList(statusText) {
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

'''
start = c.find("async function refreshUserPlaylistModalList")
end = c.find("async function refreshUserPlaylistLibrary")
if start < 0 or end < 0:
    raise SystemExit("refresh anchors missing")
c = c[:start] + new_refresh + c[end:]

# bindUserPlaylistUI: also stop modal close behavior interfering? keep close on explicit button only.
# Add: modal backdrop click does NOT close (avoid accidental dismiss), only explicit close.
old_modal_bind = "if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeAddToPlaylistModal(); });"
new_modal_bind = "if (modal) modal.addEventListener('click', (e) => { /* backdrop click does not close; use × button */ });"
if old_modal_bind in c:
    c = c.replace(old_modal_bind, new_modal_bind)
    print("modal backdrop no auto close")

# ---------- 2) Desktop right panel: keep open after add (no close) ----------
# Nothing in desktop handler closes panel; the "jump away" was modal close. Fixed above.

# ---------- 3) Mobile: do NOT close sheet when using +列表/歌单; only close when tapping song to play ----------
old_mobile = '''                        const addQueueBtn = div.querySelector('.js-add-queue');
                        const addPlBtn = div.querySelector('.js-add-playlist');
                        try {
                            const payload = JSON.stringify(newSong);
                            if (addQueueBtn) addQueueBtn.dataset.song = payload;
                            if (addPlBtn) addPlBtn.dataset.song = payload;
                        } catch (_) {}
                        if (addQueueBtn) {
                            addQueueBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.addSongToQueueOnly(newSong);
                                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                                this.loadPlaylist();
                            };
                        }
                        if (addPlBtn) {
                            addPlBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.openAddToPlaylistModal(newSong);
                            };
                        }'''
new_mobile = '''                        const addQueueBtn = div.querySelector('.js-add-queue');
                        const addPlBtn = div.querySelector('.js-add-playlist');
                        try {
                            const payload = JSON.stringify(newSong);
                            if (addQueueBtn) addQueueBtn.dataset.song = payload;
                            if (addPlBtn) addPlBtn.dataset.song = payload;
                        } catch (_) {}
                        if (addQueueBtn) {
                            addQueueBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.addSongToQueueOnly(newSong);
                                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                                this.loadPlaylist();
                                // Keep search sheet open for batch adding
                            };
                        }
                        if (addPlBtn) {
                            addPlBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.openAddToPlaylistModal(newSong);
                                // Keep search sheet open under modal
                            };
                        }'''
if old_mobile in c:
    c = c.replace(old_mobile, new_mobile)
    print("mobile add handlers keep sheet")

# ---------- 4) Queue UX: Clear all button in playlist header ----------
# Add to desktop playlist count area
anchor = 'id="playlistCount"'
if 'id="clearQueueBtn"' not in c:
    i = c.find(anchor)
    if i > 0:
        # insert near playlist header buttons
        insert_at = c.find("playlistSourceCard", i)
        # simpler: after playlistCount span close tag
        # find the element and append button after its parent? Place before source card.
        # Find exact html for count span
        m = re.search(r'(<span id="playlistCount"[^>]*>.*?</span>)', c, re.S)
        if m:
            c = c.replace(m.group(0), m.group(0) + '\n<button id="clearQueueBtn" type="button" class="ml-2 px-2 py-1 rounded-lg bg-white/10 text-xs opacity-70 hover:opacity-100" title="清空播放列表">清空</button>', 1)
            print("clear button added")

# bind clear in bindUserPlaylistUI global click
old_clear_block = """                if (t.closest('#closeUserPlaylistModal')) {
                    e.preventDefault();
                    closeAddToPlaylistModal();
                    return;
                }"""
new_clear_block = """                if (t.closest('#closeUserPlaylistModal')) {
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
                }"""
if old_clear_block in c:
    c = c.replace(old_clear_block, new_clear_block)
    print("clear handler added")

# ---------- 5) Better errors: search failure hint ----------
# leave existing

# ---------- 6) Ensure insertSongToPlaylist also dedupe? keep duplicates allowed for now.
# ---------- 7) SW bump ----------
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v23-ux-batch'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("no auto close add", "DO NOT close modal" in c)
print("clear btn", "clearQueueBtn" in c)
