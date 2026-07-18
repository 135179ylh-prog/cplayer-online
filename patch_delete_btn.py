from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# Mobile playlist item: replace icon-only trash with visible text button
old = '''                            <button type="button" class="js-remove-queue flex-none w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/70 active:bg-red-500/30" title="删除" aria-label="删除">
                                <i class="fas fa-trash text-xs"></i>
                            </button>'''
new = '''                            <button type="button" class="js-remove-queue flex-none w-12 h-9 rounded-full border border-white/25 flex items-center justify-center text-white/85 text-xs active:bg-red-500/40" title="删除" aria-label="删除" style="pointer-events:auto;z-index:5;position:relative;">
                                删
                            </button>'''
if old in c:
    c = c.replace(old, new)
    print("mobile delete button -> 删")
else:
    print("old mobile delete html not found exact")

# Desktop vsCreateItem: ensure delete button exists and visible text too (optional keep icon)
# Bump sw
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v22-del-btn'", s, count=1)
sw.write_text(s, encoding="utf-8")

# quick syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c)
print("size", p.stat().st_size)
print("has text delete", 'js-remove-queue flex-none w-12' in c)
