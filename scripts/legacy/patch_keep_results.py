from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- 1) Keep search results visible after adding (desktop + mobile) ----------
# Desktop add handlers: re-render search results container after add (keep list, just toast)
# Find desktop block around addSongToQueueOnly(newSong)
old_block = '''                        addBtn.onclick = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.addSongToQueueOnly(newSong);
                        };
                        plBtn.onclick = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.openAddToPlaylistModal(newSong);
                        };'''
new_block = '''                        addBtn.onclick = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.addSongToQueueOnly(newSong);
                            // keep search results visible; just refresh playlist counters
                            if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                        };
                        plBtn.onclick = function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.openAddToPlaylistModal(newSong);
                        };'''
if old_block in c:
    c = c.replace(old_block, new_block)
    print("desktop keep results patched")

# Mobile handler: keep sheet open; already no closeSheet, but ensure loadPlaylist doesn't clear search. Patch addQueueBtn to not reload search UI.
old_mobile = '''                            addQueueBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.addSongToQueueOnly(newSong);
                                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                                this.loadPlaylist();
                            };'''
new_mobile = '''                            addQueueBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.addSongToQueueOnly(newSong);
                                if (typeof renderAllPlaylistItems === 'function') renderAllPlaylistItems();
                                // Do NOT reload search list; keep results visible for batch adding
                            };'''
if old_mobile in c:
    c = c.replace(old_mobile, new_mobile)
    print("mobile keep results patched")

# ---------- 2) Make Clear Queue button more visible ----------
# Replace existing clearQueueBtn styling if present
c = c.replace('id="clearQueueBtn" type="button" class="ml-2 px-2 py-1 rounded-lg bg-white/10 text-xs opacity-70 hover:opacity-100"',
              'id="clearQueueBtn" type="button" class="ml-2 px-3 py-1.5 rounded-lg bg-red-500/20 text-red-200 text-xs font-medium hover:bg-red-500/30 border border-red-400/30"')
# If not found (rollback maybe), insert near playlistCount
if 'id="clearQueueBtn"' not in c:
    m = re.search(r'(<span id="playlistCount"[^>]*>.*?</span>)', c, re.S)
    if m:
        c = c.replace(m.group(0), m.group(0) + '\n<button id="clearQueueBtn" type="button" class="ml-2 px-3 py-1.5 rounded-lg bg-red-500/20 text-red-200 text-xs font-medium hover:bg-red-500/30 border border-red-400/30" title="清空播放列表">清空列表</button>', 1)
        print("clearQueueBtn inserted")
else:
    print("clearQueueBtn styled")

# ---------- 3) Add a Clear button in mobile sheet header too ----------
if 'id="mClearQueueBtn"' not in c:
    # Insert near mobile sheet header controls: find mobile sheet close button id
    anchor = 'id="mobileCloseSheetBtn"'
    i = c.find(anchor)
    if i > 0:
        # place before it in same flex container
        line_start = c.rfind("\n", 0, i)
        c = c[:line_start] + '\n<button id="mClearQueueBtn" type="button" class="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-200 text-xs border border-red-400/30">清空</button>' + c[line_start:]
        print("mobile clear inserted")

# Bind mobile clear in global delegate
bind_marker = "if (t.closest('#clearQueueBtn'))"
bi = c.find(bind_marker)
if bi > 0 and "mClearQueueBtn" not in c[c.find("function bindUserPlaylistUI"):c.find("function bindUserPlaylistUI")+3000]:
    inject = '''                if (t.closest('#mClearQueueBtn')) {
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
'''
    c = c[:bi] + inject + c[bi:]
    print("mobile clear bind added")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v25-keep-results'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("clearQueueBtn", "clearQueueBtn" in c, "mClearQueueBtn", "mClearQueueBtn" in c)
