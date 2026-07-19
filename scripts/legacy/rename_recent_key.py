from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
c = c.replace("const RECENT_KEY = 'cplayer_recent_plays';", "const PLAY_HISTORY_KEY = 'cplayer_recent_plays';")
c = c.replace("RECENT_KEY", "PLAY_HISTORY_KEY")
# restore key string
c = c.replace("const PLAY_HISTORY_KEY = 'cplayer_recent_plays';", "const PLAY_HISTORY_KEY = 'cplayer_recent_plays';")
p.write_text(c, encoding="utf-8")
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
print("renamed to PLAY_HISTORY_KEY")
