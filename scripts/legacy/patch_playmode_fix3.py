from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

logic = '''

        // Play mode (sequence / repeat_one / shuffle)
        const PLAY_MODES = ['sequence', 'repeat_one', 'shuffle'];
        const PLAY_MODE_LABELS = { sequence: '顺序播放', repeat_one: '单曲循环', shuffle: '随机播放' };
        function updatePlayModeUI() {
            const mBtn = document.getElementById('mPlayModeBtn');
            if (mBtn) mBtn.textContent = (PLAY_MODE_LABELS[playMode] || '模式').replace('播放','');
            const btn = document.getElementById('playModeBtn');
            if (btn) btn.title = PLAY_MODE_LABELS[playMode] || '播放模式';
        }
        function cyclePlayMode() {
            const idx = PLAY_MODES.indexOf(playMode);
            playMode = PLAY_MODES[(idx + 1) % PLAY_MODES.length];
            try { localStorage.setItem('cp_play_mode', playMode); } catch(e){}
            updatePlayModeUI();
            if (typeof showToast === 'function') showToast('播放模式: ' + (PLAY_MODE_LABELS[playMode] || playMode));
            try { console.log('[playMode]', playMode); } catch(e){}
        }
        window.cyclePlayMode = cyclePlayMode;
        window.updatePlayModeUI = updatePlayModeUI;
'''

anchor = "let playlist = [], currentIndex = -1, playMode = 'random';"
i = c.find(anchor)
if i < 0:
    raise SystemExit("anchor not found")
line_end = c.find("\n", i)
c = c[:line_end] + logic + c[line_end:]
print("play mode logic inserted")

# init saved mode on boot
if "updatePlayModeUI();" not in c:
    bm = c.find("initEventListeners();")
    if bm > 0:
        c = c.replace("initEventListeners();", "initEventListeners();\n            try { const saved = localStorage.getItem('cp_play_mode'); if (saved) playMode = saved; } catch(e){}\n            if (typeof updatePlayModeUI === 'function') updatePlayModeUI();", 1)
        print("play mode init added")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v32-playmode-fix3'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("PLAY_MODES", "PLAY_MODES" in c, "cyclePlayMode", "cyclePlayMode" in c)
