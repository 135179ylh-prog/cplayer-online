from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")

# Remove ALL duplicate helper blocks (keep first)
marker = "// ===== Playlist detail + recent history + export/import ====="
end_marker = "        }\n\n        function bindUserPlaylistUI"
first = c.find(marker)
if first < 0:
    print("no marker")
    raise SystemExit()
# find all occurrences
positions = []
idx = first
while idx >= 0:
    positions.append(idx)
    idx = c.find(marker, idx + 1)
print("helper block count:", len(positions))
if len(positions) > 1:
    # remove all after first
    for pos in reversed(positions[1:]):
        end = c.find(end_marker, pos)
        if end > pos:
            c = c[:pos] + c[end:]
        else:
            print("WARN: could not find end for dup at", pos)
    print("dups removed")

# Remove duplicate detail modal HTML (keep first)
detail_id = 'id="playlistDetailModal"'
positions2 = []
idx = c.find(detail_id)
while idx >= 0:
    positions2.append(idx)
    idx = c.find(detail_id, idx + 1)
print("detail modal count:", len(positions2))
if len(positions2) > 1:
    # find start of the div containing id, remove from 2nd onwards
    for pos in reversed(positions2[1:]):
        # find the <div that opens this
        start = c.rfind("<div", 0, pos)
        # find closing </div> for this modal
        # count divs
        depth = 0
        i = start
        while i < len(c):
            if c.startswith("<div", i):
                depth += 1
            elif c.startswith("</div>", i):
                depth -= 1
                if depth == 0:
                    end_pos = i + 6
                    break
            i += 1
        else:
            end_pos = pos + 2000
        c = c[:start] + c[end_pos:]
    print("dup modals removed")

# Check library detail button dedup
lib_count = c.count('data-act="detail"')
print("library detail button count:", lib_count)

# Check settings section dedup
settings_count = c.count('id="recentHistoryList"')
print("settings section count:", settings_count)

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("final size", p.stat().st_size)
