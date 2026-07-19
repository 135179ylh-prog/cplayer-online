from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

c = c.replace("const PLAY_MODES = ['sequence', 'repeat_one', 'shuffle'];", "const PLAY_MODES = ['sequence', 'repeat_one', 'repeat_all', 'shuffle'];")
c = c.replace("const PLAY_MODE_LABELS = { sequence: '顺序播放', repeat_one: '单曲循环', shuffle: '随机播放' };", "const PLAY_MODE_LABELS = { sequence: '顺序播放', repeat_one: '单曲循环', repeat_all: '列表循环', shuffle: '随机播放' };")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v33-repeat-all'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("repeat_all", "repeat_all" in c)
