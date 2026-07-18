from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- 1) Play mode cycle logic + icons ----------
# Find existing playMode toggle handler
old_handler = "dom.playModeBtn.addEventListener('click'"
if "const PLAY_MODES = ['sequence', 'repeat_one', 'shuffle'];" not in c:
    logic = '''
        const PLAY_MODES = ['sequence', 'repeat_one', 'shuffle'];
        const PLAY_MODE_LABELS = { sequence: '顺序播放', repeat_one: '单曲循环', shuffle: '随机播放' };
        const PLAY_MODE_ICONS = { sequence: 'fa-list-ol', repeat_one: 'fa-redo', shuffle: 'fa-random' };
        function updatePlayModeUI() {
            const icon = document.querySelector('#playModeBtn i');
            if (icon) {
                icon.className = 'fas ' + (PLAY_MODE_ICONS[playMode] || 'fa-list-ol') + ' text-lg';
            }
            const btn = document.getElementById('playModeBtn');
            if (btn) btn.title = PLAY_MODE_LABELS[playMode] || '播放模式';
            const mIcon = document.querySelector('#mPlayModeBtn i');
            if (mIcon) {
                mIcon.className = 'fas ' + (PLAY_MODE_ICONS[playMode] || 'fa-list-ol') + ' text-sm';
            }
        }
        function cyclePlayMode() {
            const idx = PLAY_MODES.indexOf(playMode);
            playMode = PLAY_MODES[(idx + 1) % PLAY_MODES.length];
            localStorage.setItem('cp_play_mode', playMode);
            updatePlayModeUI();
            if (typeof showToast === 'function') showToast('播放模式: ' + (PLAY_MODE_LABELS[playMode] || playMode));
        }
        window.cyclePlayMode = cyclePlayMode;
        window.updatePlayModeUI = updatePlayModeUI;
'''
    # insert after playMode declaration
    m = re.search(r"let playMode = '[^']+';", c)
    if m:
        c = c[:m.end()] + "\n" + logic + c[m.end():]
        print("play mode logic inserted")

# Restore saved mode on boot
boot_marker = "updatePlayModeUI();"
if boot_marker not in c:
    bm = c.find("initEventListeners();")
    if bm > 0:
        c = c.replace("initEventListeners();", "initEventListeners();\n            try { const saved = localStorage.getItem('cp_play_mode'); if (saved) playMode = saved; } catch(e){}\n            if (typeof updatePlayModeUI === 'function') updatePlayModeUI();", 1)
        print("play mode init added")

# Bind desktop button to cyclePlayMode if not already
if "playModeBtn.addEventListener('click', cyclePlayMode" not in c and "dom.playModeBtn.addEventListener('click'" in c:
    c = c.replace("dom.playModeBtn.addEventListener('click',", "dom.playModeBtn.addEventListener('click', cyclePlayMode); dom.playModeBtn.addEventListener('click',", 1)
    print("desktop play mode bound")

# ---------- 2) Mobile play-mode button in bottom bar ----------
if 'id="mPlayModeBtn"' not in c:
    # Insert near mobile next button in bottom mini player
    anchor = 'id="mobileNextBtn"'
    i = c.find(anchor)
    if i > 0:
        line_start = c.rfind("\n", 0, i)
        c = c[:line_start] + '\n<button id="mPlayModeBtn" type="button" class="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center"><i class="fas fa-list-ol text-sm"></i></button>' + c[line_start:]
        print("mobile play mode button inserted")

# Bind mobile play mode in global delegate
bind_marker = "if (t.closest('#clearQueueBtn'))"
bi = c.find(bind_marker)
if bi > 0 and "mPlayModeBtn" not in c[c.find("function bindUserPlaylistUI"):c.find("function bindUserPlaylistUI")+3000]:
    inject = '''                if (t.closest('#mPlayModeBtn')) {
                    e.preventDefault();
                    if (typeof cyclePlayMode === 'function') cyclePlayMode();
                    return;
                }
'''
    c = c[:bi] + inject + c[bi:]
    print("mobile play mode bind added")

# ---------- 3) Mobile clear queue button in bottom sheet header ----------
if 'id="mClearQueueBtn"' not in c:
    # Insert near mobile sheet tab header (playlist tab area)
    anchor2 = 'id="mobilePlaylistTab"'
    i2 = c.find(anchor2)
    if i2 > 0:
        line_start2 = c.rfind("\n", 0, i2)
        c = c[:line_start2] + '\n<button id="mClearQueueBtn" type="button" class="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-200 text-xs border border-red-400/30">清空</button>' + c[line_start2:]
        print("mobile clear button inserted")

# Bind mobile clear in global delegate
bi2 = c.find(bind_marker)
if bi2 > 0 and "mClearQueueBtn" not in c[c.find("function bindUserPlaylistUI"):c.find("function bindUserPlaylistUI")+3000]:
    inject2 = '''                if (t.closest('#mClearQueueBtn')) {
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
    c = c[:bi2] + inject2 + c[bi2:]
    print("mobile clear bind added")

# ---------- 4) SW bump ----------
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v27-playmode-mobile'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("mPlayModeBtn", "mPlayModeBtn" in c, "mClearQueueBtn", "mClearQueueBtn" in c)
