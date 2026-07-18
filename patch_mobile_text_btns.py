from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# 1) Replace mobile play mode icon button with text button
old = '<button id="mPlayModeBtn" type="button" class="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center"><i class="fas fa-list-ol text-sm"></i></button>'
new = '<button id="mPlayModeBtn" type="button" class="px-3 h-9 rounded-full bg-white/10 text-xs flex items-center justify-center">模式</button>'
if old in c:
    c = c.replace(old, new)
    print("mPlayModeBtn text applied")

# 2) Add mobile clear button next to playlist toggle in bottom bar (visible)
if 'id="mClearQueueBtnBar"' not in c:
    anchor = 'id="mobilePlaylistToggleBtn"'
    i = c.find(anchor)
    if i > 0:
        line_start = c.rfind("\n", 0, i)
        c = c[:line_start] + '\n<button id="mClearQueueBtnBar" type="button" class="px-3 h-9 rounded-full bg-red-500/20 text-red-200 text-xs border border-red-400/30">清空</button>' + c[line_start:]
        print("mClearQueueBtnBar inserted")

# 3) Bind bar clear in delegate
bind_marker = "if (t.closest('#clearQueueBtn'))"
bi = c.find(bind_marker)
if bi > 0 and "mClearQueueBtnBar" not in c[c.find("function bindUserPlaylistUI"):c.find("function bindUserPlaylistUI")+3500]:
    inject = '''                if (t.closest('#mClearQueueBtnBar')) {
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
    print("mClearQueueBtnBar bound")

# 4) SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v28-mobile-text-btns'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("mPlayModeBtn", "mPlayModeBtn" in c, "mClearQueueBtnBar", "mClearQueueBtnBar" in c)
