from pathlib import Path
import re
p = Path("index.html")
c = p.read_text(encoding="utf-8")

# 1) Fix library row: ensure 管理 button present
old = '''                    row.innerHTML = '<div class="flex-1 min-w-0"><div class="text-sm font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-[11px] opacity-50">' + pl.songs.length + ' 首</div></div><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="load">播放</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="del">删除</button>';'''
new = '''                    row.innerHTML = '<div class="flex-1 min-w-0"><div class="text-sm font-medium truncate">' + escapeHtml(pl.name) + '</div><div class="text-[11px] opacity-50">' + pl.songs.length + ' 首</div></div><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="detail">管理</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="load">播放</button><button type="button" class="px-2 py-1 text-xs rounded-lg bg-white/10" data-act="del">删除</button>';'''
if old in c and 'data-act="detail"' not in c[c.find("async function refreshUserPlaylistLibrary"):c.find("async function refreshUserPlaylistLibrary")+2000]:
    c = c.replace(old, new)
    print("library detail button restored")
else:
    print("library detail button check:", 'data-act="detail"' in c[c.find("async function refreshUserPlaylistLibrary"):c.find("async function refreshUserPlaylistLibrary")+2000])

# 2) Ensure detail click handler
old_click = '''                    row.querySelector('[data-act="load"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id, true); };'''
new_click = '''                    row.querySelector('[data-act="detail"]').onclick = function () { openPlaylistDetailModal(pl.id); };
                    row.querySelector('[data-act="load"]').onclick = function () { loadUserPlaylistIntoQueue(pl.id, true); };'''
if old_click in c and '[data-act="detail"]' not in c[c.find("async function refreshUserPlaylistLibrary"):c.find("async function refreshUserPlaylistLibrary")+2500]:
    c = c.replace(old_click, new_click)
    print("library detail click restored")

# 3) Add settings section (recent history + export/import) if missing
if 'id="recentHistoryList"' not in c:
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
    lib_marker = 'id="userPlaylistLibrary"'
    lib_pos = c.find(lib_marker)
    if lib_pos > 0:
        text_after = "这里可管理并一键播放歌单"
        t_pos = c.find(text_after, lib_pos)
        if t_pos > 0:
            close_div = c.find("</div>", t_pos)
            if close_div > 0:
                c = c[:close_div + 6] + "\n" + settings_section + c[close_div + 6:]
                print("settings section added")
            else:
                print("WARN close div not found")
        else:
            print("WARN text_after not found")
    else:
        print("WARN library marker not found")

# 4) Bind import input + render history in bindUserPlaylistUI end
old_end = """            refreshUserPlaylistLibrary();
        }
        window.bindUserPlaylistUI = bindUserPlaylistUI;"""
new_end = """            // Import file input
            const importInput = document.getElementById('importPlaylistsInput');
            if (importInput) {
                importInput.addEventListener('change', async function (e) {
                    const file = e.target.files && e.target.files[0];
                    if (!file) return;
                    try {
                        const count = await importUserPlaylists(file);
                        if (typeof showToast === 'function') showToast('已导入 ' + count + ' 个歌单');
                        await refreshUserPlaylistLibrary();
                    } catch (err) {
                        console.error(err);
                        if (typeof showToast === 'function') showToast('导入失败: ' + (err.message || err), true);
                    }
                    importInput.value = '';
                });
            }
            refreshUserPlaylistLibrary();
            renderRecentHistory();
        }
        window.bindUserPlaylistUI = bindUserPlaylistUI;"""
if old_end in c:
    c = c.replace(old_end, new_end)
    print("bind end updated")

# 5) openSettings renders history
if "function openSettings() {" in c and "renderRecentHistory" not in c[c.find("function openSettings() {"):c.find("function openSettings() {")+500]:
    c = c.replace(
        "function openSettings() {",
        "function openSettings() {\n            try { if (typeof renderRecentHistory === 'function') renderRecentHistory(); } catch (e) {}",
        1,
    )
    print("openSettings renders history")

# 6) SW bump
sw = Path("sw.js")
s = sw.read_text(encoding="utf-8")
s = re.sub(r"const CACHE_NAME = '[^']+'", "const CACHE_NAME = 'cplayer5-v24-detail-history'", s, count=1)
sw.write_text(s, encoding="utf-8")

# 7) Syntax extract
scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", c)
script = max(scripts, key=len)
Path("_check.js").write_text(script, encoding="utf-8")
p.write_text(c, encoding="utf-8")
print("size", p.stat().st_size)
print("recentHistoryList in HTML:", 'id="recentHistoryList"' in c)
print("importPlaylistsInput:", 'id="importPlaylistsInput"' in c)
