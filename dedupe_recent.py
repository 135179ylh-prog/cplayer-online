from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
# find RECENT_KEY declarations
idxs = [m.start() for m in re.finditer(r"const RECENT_KEY = 'cplayer_recent_plays';", c)]
print("RECENT_KEY count", len(idxs))
if len(idxs) > 1:
    # keep first block, remove subsequent duplicate block until window.pushRecentPlay line end
    first = idxs[0]
    # find end of first block
    end_marker = "window.pushRecentPlay = pushRecentPlay;"
    first_end = c.find(end_marker, first)
    first_end = c.find("\n", first_end)
    # remove any additional occurrences after first_end
    rest = c[first_end:]
    rest = re.sub(r"\n\s*const RECENT_KEY = 'cplayer_recent_plays';[\s\S]*?window\.pushRecentPlay = pushRecentPlay;\n", "\n", rest)
    c = c[:first_end] + rest
    print("deduped RECENT_KEY")
p.write_text(c, encoding="utf-8")
