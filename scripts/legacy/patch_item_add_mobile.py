from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

old = '''                            <button type="button" class="js-remove-queue flex-none w-12 h-9 rounded-full border border-white/25 flex items-center justify-center text-white/85 text-xs active:bg-red-500/40" title="删除" aria-label="删除" style="pointer-events:auto;z-index:5;position:relative;">
                                删
                            </button>'''
new = '''                            <button type="button" class="js-add-playlist-item flex-none w-10 h-9 rounded-full border border-white/25 flex items-center justify-center text-white/85 text-xs active:bg-white/10" title="歌单" aria-label="歌单" style="pointer-events:auto;z-index:5;position:relative;">
                                +
                            </button>
                            <button type="button" class="js-remove-queue flex-none w-12 h-9 rounded-full border border-white/25 flex items-center justify-center text-white/85 text-xs active:bg-red-500/40" title="删除" aria-label="删除" style="pointer-events:auto;z-index:5;position:relative;">
                                删
                            </button>'''
if old in c:
    c = c.replace(old, new)
    print("mobile item + inserted")

# bind addPlBtn in mCreateItem
old_bind = '''                        removeBtn.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            window.removeSongFromQueue(actualIndex);
                        };'''
new_bind = '''                        const addPlBtn = div.querySelector('.js-add-playlist-item');
                        if (addPlBtn) {
                            addPlBtn.onclick = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.openAddToPlaylistModal(song);
                            };
                        }
                        removeBtn.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            window.removeSongFromQueue(actualIndex);
                        };'''
if old_bind in c:
    c = c.replace(old_bind, new_bind)
    print("mobile item + bound")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v35-item-add-mobile'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("item add", "js-add-playlist-item" in c)
