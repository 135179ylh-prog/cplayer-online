from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
SW = (ROOT / "sw.js").read_text(encoding="utf-8")
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
WORKFLOW = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
GITIGNORE = (ROOT / ".gitignore").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


required_html = {
    "current queue restore": "if (!cached || !Array.isArray(cached.songs)) return false;",
    "queue serialization": "let queueSaveInFlight = null;",
    "lifecycle flush": "flushScheduledQueueSave('pagehide');",
    "desktop search race guard": "let desktopSearchRequestId = 0;",
    "mobile search race guard": "this.searchRequestId = 0;",
    "API timeout wrapper": "async function fetchJsonWithTimeout",
    "API retry primitive": "fetchJsonWithRetry",
    "central API config": "meta[name=\"cplayer-api-base-url\"]",
    "offline feedback": "window.addEventListener('offline'",
    "safe search title": "titleDiv.textContent = song.name ||",
    "mobile instance export": "window.mobileUI = mobileUI;",
    "mobile add action": "this.loadPlaylist();",
    "bounded mobile initialization": "playlistWaitAttempts >= 40",
    "service worker update policy": "updateViaCache: 'none'",
    "desktop cover sizing": 'width="300" height="300" decoding="async"',
    "dynamic cover sizing": 'width="40" height="40" decoding="async"',
    "decorative canvas semantics": 'id="fluidBg" class="fixed inset-0 w-full h-full -z-10 pointer-events-none" aria-hidden="true"',
}

for label, snippet in required_html.items():
    require(snippet in HTML, f"missing {label}: {snippet}")

require("self.loadPlaylist();" not in HTML, "mobile search still uses the window self object")
require("mob-search-img-${song.id}" not in HTML, "external song id is still interpolated into mobile HTML")
require(HTML.count("const RECENT_HISTORY_KEY = 'cp_recent_history';") == 1, "recent history key is duplicated")
require((ROOT / "playlist.js").is_file(), "optional playlist.js hook is missing")
require((ROOT / "js" / "core-utils.js").is_file(), "core utility module is missing")
require((ROOT / "tests" / "core-utils.test.mjs").is_file(), "core utility tests are missing")

require("cplayer5-v47-audit-hardening" in SW, "service worker cache version is not updated")
require("./js/core-utils.js" in SW, "core utility module is not precached")
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

deployment_assets = [
    "index.html", "playlist-downloader.html", "playlist.js", "manifest.json", "sw.js",
    "css", "fonts", "img", "js", "webfonts",
]
require('site_dir="$RUNNER_TEMP/cplayer-pages"' in WORKFLOW, "Pages staging directory is missing")
require("path: ${{ runner.temp }}/cplayer-pages" in WORKFLOW, "Pages artifact does not use the staging directory")
require(not re.search(r"^\s*path:\s+\.\s*$", WORKFLOW, flags=re.MULTILINE), "Pages still uploads the repository root")
for asset in deployment_assets:
    require(asset in WORKFLOW, f"Pages staging artifact is missing {asset}")
    require((ROOT / asset).exists(), f"Pages staging source is missing {asset}")
require(not (ROOT / "_headers").exists(), "unsupported Pages _headers file is still present")

required_ignore_rules = [
    "/.agents/skills/*", "/.claude/", "/.codex/", "/.trellis/config.yaml",
    "/.trellis/scripts/*", "!/.trellis/scripts/get_context.py", "/.trellis/spec/",
]
for rule in required_ignore_rules:
    require(rule in GITIGNORE, f"missing local runtime ignore rule: {rule}")
require("api.chksz.top" in README, "README does not document the upstream API dependency")
require("Service Worker 的缓存修订号" in README, "README does not explain version semantics")

legacy_names = [
    "dedup_detail.py", "dedupe_recent.py", "find_cycle.py", "find_manage.py", "find_vars.py",
    "fix_dup2.py", "inspect_search.py", "patch_search_fix.py", "wire_recent_builtin.py",
]
require(all(not (ROOT / name).exists() for name in legacy_names), "legacy debug scripts still pollute the root")

badge = re.search(r'id="buildBadge"[^>]*>(v\d+)', HTML)
require(badge, "build badge is missing or malformed")
require("CPlayer 5 • 当前构建见左下角" in HTML, "settings version text is misleading")

print("stability checks: passed")
print("build badge:", badge.group(1))
print("core assets:", len(re.findall(r"^  './", SW, flags=re.MULTILINE)))
print("playlist hook:", (ROOT / "playlist.js").stat().st_size, "bytes")
