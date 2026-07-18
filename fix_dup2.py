from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
# Remove second helper block: from marker at ~105101 to just before "function bindUserPlaylistUI" at ~115128
m = "// ===== Playlist detail + recent history + export/import ====="
second_start = c.find(m, 100000)
bind_pos = c.find("function bindUserPlaylistUI", second_start)
if second_start > 0 and bind_pos > second_start:
    # find the start of the line containing second marker
    line_start = c.rfind("\n", 0, second_start)
    c = c[:line_start] + "\n        " + c[bind_pos:]
    print("removed second block")
# Verify only one
print("remaining markers:", c.count(m))
# Also dedup library detail buttons if 3 (keep 1 per row = 1 in template)
lib_count = c.count('data-act="detail"')
print("detail buttons:", lib_count)
# syntax
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("size", p.stat().st_size)
