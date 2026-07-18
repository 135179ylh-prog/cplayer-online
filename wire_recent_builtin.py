from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")

# 1) Manage button opens detail
old = "row.querySelector('[data-act=\"detail\"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id); closePlaylistPanel(); };"
new = "row.querySelector('[data-act=\"detail\"]').onclick = function () { openPlaylistDetail(pl.id); };"
if old in c:
    c = c.replace(old, new)
    print("manage opens detail fixed")
else:
    print("manage pattern still not found")

# 2) Wire custom recent list to built-in cp_recent_history via play hook
hook_marker = "playSongAtIndex = function (index)"
if "window.__recentPlayHookInstalled" not in c:
    hook = '''
        // Bridge built-in recent history (cp_recent_history) into our UI list
        window.__recentPlayHookInstalled = true;
        window.__recentListUpdate = function (song) {
            try {
                const raw = localStorage.getItem('cp_recent_history');
                const arr = raw ? JSON.parse(raw) : [];
                if (Array.isArray(arr) && arr.length) {
                    const last = arr[arr.length - 1];
                    if (window.renderRecentPlays) {
                        // map to normalized song and re-render from same storage
                        renderRecentPlays();
                    }
                }
            } catch (e) {}
        };
'''
    # place after normalizeSongObject definition marker
    nm = c.find("function normalizeSongObject")
    if nm > 0:
        line_end = c.find("\n", nm)
        c = c[:line_end] + "\n" + hook + c[line_end:]
        print("recent hook inserted")

# 3) Make renderRecentPlays read cp_recent_history
c = c.replace("const raw = localStorage.getItem(PLAY_HISTORY_KEY);", "const raw = localStorage.getItem('cp_recent_history');")
c = c.replace("localStorage.setItem(PLAY_HISTORY_KEY,", "localStorage.setItem('cp_recent_history',")
c = c.replace("localStorage.removeItem(PLAY_HISTORY_KEY);", "localStorage.removeItem('cp_recent_history');")

# 4) pushRecentPlay no longer used for built-in; keep but harmless. Ensure no duplicate names now.
p.write_text(c, encoding="utf-8")
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
print("size", p.stat().st_size)
