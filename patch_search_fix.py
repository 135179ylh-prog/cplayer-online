from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- 1) Force show search results container after search ----------
# In searchSongs, after container.innerHTML = '' ensure visible
old = "const results = await musicService.search(query);\n                    container.innerHTML = '';"
new = "const results = await musicService.search(query);\n                    container.innerHTML = '';\n                    container.classList.remove('hidden');"
if old in c:
    c = c.replace(old, new)
    print("show results container patched")

# Also ensure search input handler switches to search tab on desktop
old_btn = "dom.searchButton.addEventListener('click', () => searchSongs(dom.searchInput.value));"
new_btn = "dom.searchButton.addEventListener('click', () => { if (window.innerWidth >= 768 && typeof switchDesktopTab === 'function') switchDesktopTab('search'); searchSongs(dom.searchInput.value); });"
if old_btn in c:
    c = c.replace(old_btn, new_btn)
    print("search button tab switch patched")

old_key = "dom.searchInput.addEventListener('keypress', (e) => e.key === 'Enter' && searchSongs(dom.searchInput.value));"
new_key = "dom.searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { if (window.innerWidth >= 768 && typeof switchDesktopTab === 'function') switchDesktopTab('search'); searchSongs(dom.searchInput.value); } });"
if old_key in c:
    c = c.replace(old_key, new_key)
    print("search enter tab switch patched")

# ---------- 2) Clear button more visible (desktop) ----------
c = c.replace('id="clearQueueBtn" type="button" class="ml-2 px-2 py-1 rounded-lg bg-white/10 text-xs opacity-70 hover:opacity-100"',
              'id="clearQueueBtn" type="button" class="ml-2 px-3 py-1.5 rounded-lg bg-red-500/20 text-red-200 text-xs font-medium hover:bg-red-500/30 border border-red-400/30"')

# ---------- 3) SW bump ----------
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v26-search-fix'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("show results", "container.classList.remove('hidden')" in c)
print("tab switch", "switchDesktopTab('search')" in c)
