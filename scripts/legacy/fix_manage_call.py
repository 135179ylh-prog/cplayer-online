from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
c = c.replace("openPlaylistDetailModal(pl.id)", "openPlaylistDetail(pl.id)")
# if built-in had openPlaylistDetailModal defined elsewhere, leave; our function name is openPlaylistDetail
p.write_text(c, encoding="utf-8")
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
print("fixed manage call")
