import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
SW = (ROOT / "sw.js").read_text(encoding="utf-8")
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


required_html = {
    "current queue restore": "if (!cached || !Array.isArray(cached.songs)) return false;",
    "queue serialization": "let queueSaveInFlight = null;",
    "lifecycle flush": "flushScheduledQueueSave('pagehide');",
    "desktop search race guard": "let desktopSearchRequestId = 0;",
    "mobile search race guard": "this.searchRequestId = 0;",
    "API timeout": "async function fetchJsonWithTimeout",
    "safe search title": "titleDiv.textContent = song.name || '未知歌曲';",
    "mobile instance export": "window.mobileUI = mobileUI;",
    "mobile add action": "this.loadPlaylist();",
    "bounded mobile initialization": "playlistWaitAttempts >= 40",
    "service worker update policy": "updateViaCache: 'none'",
}

for label, snippet in required_html.items():
    require(snippet in HTML, f"missing {label}: {snippet}")

require("self.loadPlaylist();" not in HTML, "mobile search still uses the window self object")
require("mob-search-img-${song.id}" not in HTML, "external song id is still interpolated into mobile HTML")
require(HTML.count("const RECENT_HISTORY_KEY = 'cp_recent_history';") == 1, "recent history key is duplicated")
require((ROOT / "playlist.js").is_file(), "optional playlist.js hook is missing")

require("cplayer5-v46-stability-hardening" in SW, "service worker cache version is not updated")
require("cacheCoreAssets" in SW and "new Request(new URL(asset, self.registration.scope)" in SW, "core cache refresh is not explicit")
require("const COVER_CACHE_LIMIT = 160;" in SW, "cover cache has no bounded limit")
require("k.startsWith('cplayer5-') && k !== CACHE_NAME" in SW, "cache cleanup is not scoped to this app")
require("event.request.mode === 'navigate'" in SW, "navigation fallback is missing")
require("isAppShellNavigation(url)" in SW, "navigation cache writes are not limited to the app shell")
require("url.pathname === scope.pathname" in SW, "app shell navigation does not recognize the scoped root")
image_branch = SW.find("url.hostname.includes('music.126.net') && url.pathname.match")
cdn_network_branch = SW.find("url.hostname.includes('music.126.net'))")
require(image_branch >= 0 and cdn_network_branch > image_branch, "cover cache branch is shadowed by CDN network branch")

require(MANIFEST.get("start_url") == "./index.html", "manifest start_url changed unexpectedly")
require(any(icon.get("src") == "img/icon.png" for icon in MANIFEST.get("icons", [])), "PNG app icon is missing")

print("stability checks: passed")
print("build badge:", re.search(r'id="buildBadge"[^>]*>(v\d+)', HTML).group(1))
print("core assets:", len(re.findall(r"^  './", SW, flags=re.MULTILINE)))
print("playlist hook:", (ROOT / "playlist.js").stat().st_size, "bytes")
