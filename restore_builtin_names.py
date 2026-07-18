from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
# restore built-in recent block names
c = c.replace("const PLAY_HISTORY_KEY = 'cp_recent_history';", "const RECENT_KEY = 'cp_recent_history';")
c = c.replace("loadPLAY_HISTORY_KEY", "loadRecentHistory")
c = c.replace("PLAY_HISTORY_KEY.slice", "RECENT_KEY.slice")  # safety if weird
p.write_text(c, encoding="utf-8")
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
print("restored built-in names")
