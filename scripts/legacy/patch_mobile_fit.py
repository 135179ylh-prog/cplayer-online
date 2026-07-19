from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")
orig = c

# ---------- Mobile layout adjustments ----------
# 1) Add safe-area padding and move mobile controls lower
css = '''
        /* Mobile foldable safe-area + reachability tweaks */
        @media (max-width: 768px) {
            body { padding-top: env(safe-area-inset-top); }
            #mobileUI { padding-bottom: calc(env(safe-area-inset-bottom) + 12px); }
            .mobile-controls { padding-bottom: calc(env(safe-area-inset-bottom) + 20px); }
            #mobilePlaylistToggleBtn, #mPlayModeBtn, #mClearQueueBtnBar { min-height: 44px; min-width: 44px; }
            #mobilePlaylistToggleBtn { font-size: 14px; }
        }
'''
if "foldable safe-area" not in c:
    # insert before </style>
    idx = c.rfind("</style>")
    if idx > 0:
        c = c[:idx] + css + c[idx:]
        print("mobile css inserted")

# 2) Make mobile bottom bar buttons larger/text
c = c.replace('id="mPlayModeBtn" type="button" class="px-3 h-9 rounded-full bg-white/10 text-xs flex items-center justify-center"',
              'id="mPlayModeBtn" type="button" class="px-4 h-11 rounded-full bg-white/10 text-sm flex items-center justify-center"')
c = c.replace('id="mClearQueueBtnBar" type="button" class="px-3 h-9 rounded-full bg-red-500/20 text-red-200 text-xs border border-red-400/30"',
              'id="mClearQueueBtnBar" type="button" class="px-4 h-11 rounded-full bg-red-500/20 text-red-200 text-sm border border-red-400/30"')

# 3) Ensure playlist toggle button has text on mobile
old = '<button id="mobilePlaylistToggleBtn" class="p-3 opacity-70 active:scale-95 transition-transform"'
new = '<button id="mobilePlaylistToggleBtn" class="p-3 opacity-90 active:scale-95 transition-transform text-sm"'
if old in c:
    c = c.replace(old, new)
    print("playlist toggle styled")

# SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v36-mobile-fit'", s, count=1)
sw.write_text(s, encoding="utf-8")

# syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
Path("_check.js").write_text(max(scripts, key=len), encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("changed", orig != c, "size", p.stat().st_size)
print("mobile css", "foldable safe-area" in c)
