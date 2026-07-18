from pathlib import Path
import re
c = Path("index.html").read_text(encoding="utf-8")
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
print("RECENT_KEY count", script.count("const RECENT_KEY = 'cplayer_recent_plays';"))
print("script size", len(script))
