from pathlib import Path
import re
c = Path("index.html").read_text(encoding="utf-8")
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
print("RECENT_HISTORY_KEY count", script.count("const RECENT_HISTORY_KEY = 'cp_recent_history';"))
print("script size", len(script))
