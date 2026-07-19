from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")

# Add settings section after the library container
settings_section = '''
                    <div class="mt-5 p-4 rounded-2xl border border-white/10 bg-white/[0.04]">
                        <div class="text-sm font-medium mb-2">最近播放</div>
                        <div id="recentHistoryList" class="max-h-48 overflow-y-auto mb-2"></div>
                        <div class="flex gap-2">
                            <button id="clearRecentBtn" type="button" class="px-3 py-1.5 rounded-lg bg-white/10 text-xs">清空历史</button>
                        </div>
                    </div>
                    <div class="mt-4 p-4 rounded-2xl border border-white/10 bg-white/[0.04]">
                        <div class="text-sm font-medium mb-2">歌单备份</div>
                        <div class="flex gap-2">
                            <button id="exportPlaylistsBtn" type="button" class="px-3 py-1.5 rounded-lg bg-white/10 text-xs">导出歌单 JSON</button>
                            <label class="px-3 py-1.5 rounded-lg bg-white/10 text-xs cursor-pointer">
                                导入
                                <input id="importPlaylistsInput" type="file" accept=".json" class="hidden">
                            </label>
                        </div>
                        <p class="text-[11px] opacity-40 mt-2">导出后可保存到手机/电脑；换浏览器或清数据后可重新导入。</p>
                    </div>
'''
# Insert after the library container's closing </div>
# The container is: <div id="userPlaylistLibrary" ...></div> followed by <p ...>...</p> then </div>
lib_marker = '<div id="userPlaylistLibrary" class="max-h-48 overflow-y-auto"></div>'
lib_pos = c.find(lib_marker)
if lib_pos > 0:
    # find the closing </div> after the <p> tag
    p_tag_end = c.find("</p>", lib_pos)
    if p_tag_end > 0:
        close_div = c.find("</div>", p_tag_end)
        if close_div > 0:
            c = c[:close_div + 6] + "\n" + settings_section + c[close_div + 6:]
            print("settings section added")
        else:
            print("WARN close div not found")
    else:
        print("WARN p tag end not found")
else:
    print("WARN library marker not found")

# syntax
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("size", p.stat().st_size)
print("recentHistoryList:", 'id="recentHistoryList"' in c)
print("importPlaylistsInput:", 'id="importPlaylistsInput"' in c)
