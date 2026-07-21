from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
DOWNLOADER = (ROOT / "playlist-downloader.html").read_text(encoding="utf-8")
SW = (ROOT / "sw.js").read_text(encoding="utf-8")
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
WORKFLOW = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
GITIGNORE = (ROOT / ".gitignore").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
PLAYWRIGHT = (ROOT / "playwright.config.mjs").read_text(encoding="utf-8")
QUALITY_GATE = (ROOT / "scripts" / "run-quality-gate.mjs").read_text(encoding="utf-8")
SEARCH_E2E = (ROOT / "tests" / "e2e" / "search-recovery.spec.mjs").read_text(encoding="utf-8")
SHELL_E2E = (ROOT / "tests" / "e2e" / "app-shell.spec.mjs").read_text(encoding="utf-8")
API_CONFIG_E2E = (ROOT / "tests" / "e2e" / "api-config.spec.mjs").read_text(encoding="utf-8")
SW_UPDATE_E2E = (ROOT / "tests" / "e2e" / "service-worker-update.spec.mjs").read_text(encoding="utf-8")
RESPONSIVE_E2E = (ROOT / "tests" / "e2e" / "responsive-accessibility.spec.mjs").read_text(encoding="utf-8")
TEST_SERVER = (ROOT / "tests" / "e2e" / "server.mjs").read_text(encoding="utf-8")
OLD_SW_FIXTURE = (ROOT / "tests" / "e2e" / "fixtures" / "sw-old.js").read_text(encoding="utf-8")
CORE_UTILS = (ROOT / "js" / "core-utils.js").read_text(encoding="utf-8")


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
    "central API URL builder": "static buildUrl(path, params = {})",
    "API auth response normalization": "apiStatus === 401 || apiStatus === 403",
    "API key storage read": "localStorage.getItem('cp_api_key')",
    "API base storage read": "localStorage.getItem('cp_api_base')",
    "API settings password input": 'type="password" id="settingsApiKeyInput"',
    "PWA update notification": 'id="appUpdateBanner"',
    "PWA controller replacement listener": "navigator.serviceWorker.addEventListener('controllerchange'",
    "PWA safe update reload": "flushScheduledQueueSave('sw_update_reload')",
    "PWA update registration after queue restore": "await loadDefaultPlaylist();\n            setupServiceWorkerUpdates();",
    "offline feedback": "window.addEventListener('offline'",
    "safe search title": "titleDiv.textContent = song.name ||",
    "mobile instance export": "window.mobileUI = mobileUI;",
    "mobile add action": "this.loadPlaylist();",
    "bounded mobile initialization": "playlistWaitAttempts >= 40",
    "service worker update policy": "updateViaCache: 'none'",
    "desktop cover sizing": 'width="300" height="300" decoding="async"',
    "dynamic cover sizing": 'width="40" height="40" decoding="async"',
    "decorative canvas semantics": 'id="fluidBg" class="fixed inset-0 w-full h-full -z-10 pointer-events-none" aria-hidden="true"',
    "accessible overlay stack": "const accessibleOverlayStack = [];",
    "focus-safe overlay manager": "function openAccessibleOverlay(modal, options)",
    "keyboard progress control": "function handleProgressKeydown(event)",
    "explicit mobile view toggle": 'id="mobileViewToggle"',
    "closed mobile sheet isolation": 'id="mobilePlaylistSheet" role="region" aria-label="移动播放列表和搜索" aria-hidden="true" inert',
}

for label, snippet in required_html.items():
    require(snippet in HTML, f"missing {label}: {snippet}")

require("self.loadPlaylist();" not in HTML, "mobile search still uses the window self object")
require("mob-search-img-${song.id}" not in HTML, "external song id is still interpolated into mobile HTML")
require(HTML.count("const RECENT_HISTORY_KEY = 'cp_recent_history';") == 1, "recent history key is duplicated")
require((ROOT / "playlist.js").is_file(), "optional playlist.js hook is missing")
require((ROOT / "js" / "core-utils.js").is_file(), "core utility module is missing")
require((ROOT / "tests" / "core-utils.test.mjs").is_file(), "core utility tests are missing")
require("user-scalable=no" not in HTML and "maximum-scale" not in HTML, "viewport still blocks browser zoom")

require("cplayer5-v55-responsive-accessibility" in SW, "service worker cache version is not updated")
require("./js/core-utils.js" in SW, "core utility module is not precached")
require("./css/tailwind.css" in SW and "./js/tailwindcss.js" not in SW, "service worker Tailwind cache entry is stale")
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
require(PACKAGE.get("scripts", {}).get("build:css") == "tailwindcss -c tailwind.config.cjs -i css/tailwind.input.css -o css/tailwind.css --minify", "Tailwind build script changed unexpectedly")
require(PACKAGE.get("devDependencies", {}).get("tailwindcss") == "3.4.17", "Tailwind version is not pinned")
require(PACKAGE.get("scripts", {}).get("verify") == "node scripts/run-quality-gate.mjs", "unified quality gate is missing")
require(PACKAGE.get("scripts", {}).get("test:e2e") == "playwright test", "browser regression command is missing")
playwright_version = PACKAGE.get("devDependencies", {}).get("@playwright/test", "")
require(bool(re.fullmatch(r"\d+\.\d+\.\d+", playwright_version)), "Playwright must use an exact pinned version")
require(PACKAGE.get("devDependencies", {}).get("@axe-core/playwright") == "4.10.2", "Axe Playwright version is not pinned")
require((ROOT / "tailwind.config.cjs").is_file(), "Tailwind config is missing")
require((ROOT / "css" / "tailwind.input.css").is_file(), "Tailwind source CSS is missing")
tailwind_css = ROOT / "css" / "tailwind.css"
require(tailwind_css.is_file() and tailwind_css.stat().st_size > 0, "generated Tailwind CSS is missing")
tailwind_config = (ROOT / "tailwind.config.cjs").read_text(encoding="utf-8")
tailwind_input = (ROOT / "css" / "tailwind.input.css").read_text(encoding="utf-8")
require("'./index.html'" in tailwind_config and "'./playlist-downloader.html'" in tailwind_config, "Tailwind content scan is incomplete")
require("@tailwind base;" in tailwind_input and "@tailwind utilities;" in tailwind_input, "Tailwind source directives are incomplete")
require('href="css/tailwind.css"' in HTML and 'js/tailwindcss.js' not in HTML, "main page still uses runtime Tailwind")
require('href="css/tailwind.css"' in DOWNLOADER and 'cdn.tailwindcss.com' not in DOWNLOADER, "downloader still uses Play CDN")

deployment_assets = [
    "index.html", "playlist-downloader.html", "playlist.js", "manifest.json", "sw.js",
    "css", "fonts", "img", "js", "webfonts",
]
require('site_dir="$RUNNER_TEMP/cplayer-pages"' in WORKFLOW, "Pages staging directory is missing")
require("path: ${{ runner.temp }}/cplayer-pages" in WORKFLOW, "Pages artifact does not use the staging directory")
require(not re.search(r"^\s*path:\s+\.\s*$", WORKFLOW, flags=re.MULTILINE), "Pages still uploads the repository root")
require("quality:" in WORKFLOW and "needs: quality" in WORKFLOW, "Pages deploy is not gated by quality checks")
require("npm ci" in WORKFLOW and "playwright install --with-deps chromium" in WORKFLOW, "CI browser dependencies are not reproducible")
require("npm run verify" in WORKFLOW, "CI does not run the unified quality gate")
for asset in deployment_assets:
    require(asset in WORKFLOW, f"Pages staging artifact is missing {asset}")
    require((ROOT / asset).exists(), f"Pages staging source is missing {asset}")
require(not (ROOT / "_headers").exists(), "unsupported Pages _headers file is still present")

required_ignore_rules = [
    "/.agents/skills/*", "/.claude/", "/.codex/", "/.trellis/config.yaml",
    "/.trellis/scripts/*", "!/.trellis/scripts/get_context.py", "/.trellis/spec/",
    "output/playwright/",
]
for rule in required_ignore_rules:
    require(rule in GITIGNORE, f"missing local runtime ignore rule: {rule}")
require("api.chksz.top" in README, "README does not document the upstream API dependency")
require("Service Worker 的缓存修订号" in README, "README does not explain version semantics")
require("npm run verify" in README, "README does not document the release quality gate")
require("apikey" in README and "localStorage" in README, "README does not explain API key storage and transport")

api_endpoints = set(re.findall(r"ChKSzAPI\.buildUrl\('(/163_[a-z]+)'", HTML))
require(api_endpoints == {"/163_search", "/163_music", "/163_lyric", "/163_playlist"}, "not every ChKSz endpoint uses the central URL builder")
require("search.set('apikey', key)" in HTML, "API key is not appended through URLSearchParams")
require("localStorage.setItem('cp_api_key', key)" in HTML, "API key is not persisted from runtime input")
require("localStorage.removeItem('cp_api_key')" in HTML, "API key reset is missing")
production_source = "\n".join((HTML, DOWNLOADER, SW, CORE_UTILS))
require(not re.search(r"apikey\s*=\s*['\"][^'\"]{8,}['\"]", production_source, flags=re.IGNORECASE), "a literal API key appears to be hard-coded")
require("serviceWorkers: 'block'" in API_CONFIG_E2E and "randomUUID" in API_CONFIG_E2E, "API config browser test is not deterministic or uses a fixed key")
require("searchParams.has('apikey')" in API_CONFIG_E2E, "browser test does not prove key-free compatibility")

require("name: 'desktop-chromium'" in PLAYWRIGHT and "name: 'mobile-chromium'" in PLAYWRIGHT, "desktop/mobile browser projects are incomplete")
require("viewport: { width: 1280, height: 800 }" in PLAYWRIGHT, "desktop quality viewport changed unexpectedly")
require("viewport: { width: 390, height: 844 }" in PLAYWRIGHT, "mobile quality viewport changed unexpectedly")
require("viewport: { width: 355, height: 800 }" in PLAYWRIGHT, "narrow mobile quality viewport is missing")
require("viewport: { width: 440, height: 707 }" in PLAYWRIGHT, "wide foldable quality viewport is missing")
require(PLAYWRIGHT.count("testMatch: /responsive-accessibility") == 2, "specialized responsive projects must run only the accessibility spec")
require("workers: 1" in PLAYWRIGHT and "serviceWorkers: 'allow'" in PLAYWRIGHT, "PWA browser tests are not isolated deterministically")
require("output/playwright/" in PLAYWRIGHT, "browser artifacts are not kept under output/playwright")
require("node tests/e2e/server.mjs" in PLAYWRIGHT and "reuseExistingServer: false" in PLAYWRIGHT, "Playwright does not own the deterministic test server")
require("serviceWorkers: 'block'" in SEARCH_E2E and "page.route" in SEARCH_E2E, "search API mock can be bypassed by the Service Worker")
require("navigator.serviceWorker.controller" in SHELL_E2E and "setOffline(true)" in SHELL_E2E, "offline shell browser contract is incomplete")
require("Service-Worker-Allowed" in TEST_SERVER and "tests/e2e/fixtures/sw-old.js" in TEST_SERVER, "old Worker root-scope permission is not isolated to the test server")
require("cplayer5-test-old" in OLD_SW_FIXTURE and "self.clients.claim()" in OLD_SW_FIXTURE, "old Worker fixture does not establish an active prior installation")
for snippet in ["OLD_WORKER_PATH", "controller?.scriptURL", "UNRELATED_CACHE_NAME", "setOffline(true)", "readQueueRecord"]:
    require(snippet in SW_UPDATE_E2E, f"service worker upgrade browser contract is missing: {snippet}")
for snippet in ["AxeBuilder", "element.inert", "ArrowRight", "keyboard-progress.wav", "songRequests"]:
    require(snippet in RESPONSIVE_E2E, f"responsive accessibility browser contract is missing: {snippet}")
require("tests/e2e" not in WORKFLOW, "test-only Worker/server files must not enter the Pages artifact")
for gate_step in ["build:css", "test:unit", "check:module", "check:sw", "check:features", "audit", "test:e2e", "diff', '--check"]:
    require(gate_step in QUALITY_GATE, f"quality gate is missing step: {gate_step}")

legacy_names = [
    "dedup_detail.py", "dedupe_recent.py", "find_cycle.py", "find_manage.py", "find_vars.py",
    "fix_dup2.py", "inspect_search.py", "patch_search_fix.py", "wire_recent_builtin.py",
]
require(all(not (ROOT / name).exists() for name in legacy_names), "legacy debug scripts still pollute the root")

badge = re.search(r'id="buildBadge"[^>]*>(v\d+)', HTML)
require(badge, "build badge is missing or malformed")
require("CPlayer 5 • 当前构建见左下角" in HTML, "settings version text is misleading")
require("classifyPlaybackQuality" in HTML and "renderPlaybackQuality" in HTML, "truthful quality display is not wired")
require("quality-unknown" in HTML and "音质确认中" in HTML, "quality loading state is missing")
require("dom.qualityBadge.textContent = '💎JyMaster';" not in HTML, "quality badge still claims master before verification")
require("level: typeof d.level === 'string' ? d.level : null" in HTML, "requested quality still masquerades as API metadata")
require("document.querySelectorAll('#qualityBadge, #mobileQualityBadge')" in HTML, "quality state is not rendered to both layouts")
require("超清母带" not in HTML, "UI still guarantees master-quality playback")
require("音质未标注" in README, "README does not explain unverified quality metadata")
require("const PLAYBACK_SESSION_KEY = 'cp_playback_session';" in HTML, "playback resume storage is missing")
require("normalizePlaybackSession" in HTML and "preparePlaybackResume" in HTML, "playback resume is not wired")
require("getSafePlaybackResumeTime" in HTML, "safe playback resume boundary is not wired")
require("savePlaybackSession('timeupdate', false)" in HTML, "playback progress is not throttled through the shared saver")
require('id="sleepTimerSelect"' in HTML and "setupSleepTimerUI" in HTML, "sleep timer controls are missing")
require("classifyPlaybackFailure(error, navigator.onLine !== false)" in HTML, "playback failure feedback is not classified")
require("播放器不会绕过浏览器限制自动发声" in README, "resume autoplay limitation is undocumented")
require(HTML.count("renderSearchRecoveryState") >= 3, "desktop and mobile search retry states are not shared")
require("重试搜索：" in HTML and "当前已离线" in HTML, "search retry accessibility or offline copy is missing")

print("stability checks: passed")
print("build badge:", badge.group(1))
print("core assets:", len(re.findall(r"^  './", SW, flags=re.MULTILINE)))
print("playlist hook:", (ROOT / "playlist.js").stat().st_size, "bytes")
