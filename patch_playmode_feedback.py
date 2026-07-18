from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# Make cyclePlayMode update button text and always toast
old = "function cyclePlayMode() {"
if old not in c:
    raise SystemExit("cyclePlayMode not found")
# replace whole function body by locating from function start to next 'window.cyclePlayMode'
start = c.find(old)
end = c.find("window.cyclePlayMode = cyclePlayMode;")
if start < 0 or end < 0:
    raise SystemExit("cycle anchors missing")
new_fn = '''function cyclePlayMode() {
            const idx = PLAY_MODES.indexOf(playMode);
            playMode = PLAY_MODES[(idx + 1) % PLAY_MODES.length];
            try { localStorage.setItem('cp_play_mode', playMode); } catch(e){}
            if (typeof updatePlayModeUI === 'function') updatePlayModeUI();
            const label = PLAY_MODE_LABELS[playMode] || playMode;
            const mBtn = document.getElementById('mPlayModeBtn');
            if (mBtn) mBtn.textContent = label.replace('播放','');
            if (typeof showToast === 'function') showToast('播放模式: ' + label);
            try { console.log('[playMode]', playMode); } catch(e){}
        }
        '''
c = c[:start] + new_fn + c[end:]

# updatePlayModeUI also set mobile text
if "mBtn.textContent" not in c:
    u_start = c.find("function updatePlayModeUI() {")
    u_end = c.find("window.updatePlayModeUI = updatePlayModeUI;")
    if u_start > 0 and u_end > u_start:
        body = c[u_start:u_end]
        insert = '''
            const mBtn = document.getElementById('mPlayModeBtn');
            if (mBtn) mBtn.textContent = (PLAY_MODE_LABELS[playMode] || '模式').replace('播放','');
'''
        # insert before closing brace of function (last '}')
        pos = body.rfind("}")
        body = body[:pos] + insert + body[pos:]
        c = c[:u_start] + body + c[u_end:]

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v29-playmode-feedback'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("cycle updated", "console.log('[playMode]'" in c)
