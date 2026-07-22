from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
APP = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
DOWNLOADER = (ROOT / "playlist-downloader.html").read_text(encoding="utf-8")
SW = (ROOT / "sw.js").read_text(encoding="utf-8")
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
WORKFLOW = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
GITIGNORE = (ROOT / ".gitignore").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
PLAYWRIGHT = (ROOT / "playwright.config.mjs").read_text(encoding="utf-8")
QUALITY_GATE = (ROOT / "scripts" / "run-quality-gate.mjs").read_text(encoding="utf-8")
PAGES_BUILDER = (ROOT / "scripts" / "build-pages-artifact.mjs").read_text(encoding="utf-8")
REPOSITORY_CHECK = (ROOT / "scripts" / "check-repository-state.mjs").read_text(encoding="utf-8")
ROLLBACK_CHECK = (ROOT / "scripts" / "check-rollback-target.mjs").read_text(encoding="utf-8")
SEARCH_E2E = (ROOT / "tests" / "e2e" / "search-recovery.spec.mjs").read_text(encoding="utf-8")
SHELL_E2E = (ROOT / "tests" / "e2e" / "app-shell.spec.mjs").read_text(encoding="utf-8")
API_CONFIG_E2E = (ROOT / "tests" / "e2e" / "api-config.spec.mjs").read_text(encoding="utf-8")
SW_UPDATE_E2E = (ROOT / "tests" / "e2e" / "service-worker-update.spec.mjs").read_text(encoding="utf-8")
SW_KEY_CACHE_E2E = (ROOT / "tests" / "e2e" / "service-worker-key-cache.spec.mjs").read_text(encoding="utf-8")
STORAGE_RESILIENCE_E2E = (ROOT / "tests" / "e2e" / "storage-resilience.spec.mjs").read_text(encoding="utf-8")
RUNTIME_RESILIENCE_E2E = (ROOT / "tests" / "e2e" / "runtime-background-resilience.spec.mjs").read_text(encoding="utf-8")
PLAYBACK_ERROR_E2E = (ROOT / "tests" / "e2e" / "playback-error.spec.mjs").read_text(encoding="utf-8")
E2E_HELPERS = (ROOT / "tests" / "e2e" / "helpers.mjs").read_text(encoding="utf-8")
RESPONSIVE_E2E = (ROOT / "tests" / "e2e" / "responsive-accessibility.spec.mjs").read_text(encoding="utf-8")
RELEASE_ARTIFACT_E2E = (ROOT / "tests" / "e2e" / "release-artifact.spec.mjs").read_text(encoding="utf-8")
TEST_SERVER = (ROOT / "tests" / "e2e" / "server.mjs").read_text(encoding="utf-8")
OLD_SW_FIXTURE = (ROOT / "tests" / "e2e" / "fixtures" / "sw-old.js").read_text(encoding="utf-8")
CORE_UTILS = (ROOT / "js" / "core-utils.js").read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


required_html = {
    "external app module": '<script type="module" src="./js/app.js"></script>',
    "API settings password input": 'type="password" id="settingsApiKeyInput"',
    "PWA update notification": 'id="appUpdateBanner"',
    "desktop cover sizing": 'width="300" height="300" decoding="async"',
    "decorative canvas semantics": 'id="fluidBg" class="fixed inset-0 w-full h-full -z-10 pointer-events-none" aria-hidden="true"',
    "explicit mobile view toggle": 'id="mobileViewToggle"',
    "closed mobile sheet isolation": 'id="mobilePlaylistSheet" role="region" aria-label="移动播放列表和搜索" aria-hidden="true" inert',
}

required_app = {
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
    "API key storage read": "readLocalStorage('cp_api_key'",
    "API base storage read": "readLocalStorage('cp_api_base'",
    "PWA controller replacement listener": "navigator.serviceWorker.addEventListener('controllerchange'",
    "PWA safe update reload": "flushScheduledQueueSave('sw_update_reload')",
    "committed playback identity": "let committedMedia = null;",
    "shared media reset": "function resetPlaybackIdentity()",
    "committed media resume": "async function resumeCommittedMedia(source)",
    "ended media ownership guard": "activePlaybackAttempt.token !== committedMedia.token",
    "bounded media session seek": "function seekMainAudio(target, options)",
    "explicit app readiness": "document.documentElement.dataset.cplayerReady = 'true';",
    "visual lifecycle owner": "function syncVisualLifecycle()",
    "paused WebGL resize redraw": "if (document.visibilityState === 'visible' && !this.shouldAnimate()) this.render();",
    "offline feedback": "window.addEventListener('offline'",
    "safe search title": "titleDiv.textContent = song.name ||",
    "mobile instance export": "window.mobileUI = mobileUI;",
    "mobile add action": "this.loadPlaylist();",
    "synchronous mobile initialization": "function initCanvasRenderers()",
    "service worker update policy": "updateViaCache: 'none'",
    "dynamic cover sizing": 'width="40" height="40" decoding="async"',
    "accessible overlay stack": "const accessibleOverlayStack = [];",
    "focus-safe overlay manager": "function openAccessibleOverlay(modal, options)",
    "keyboard progress control": "function handleProgressKeydown(event)",
    "safe local storage boundary": "function readLocalStorage(key, fallback = null)",
    "database blocked lifecycle": "request.onblocked = () =>",
    "database version lifecycle": "connection.onversionchange = () =>",
    "transaction completion boundary": "function transactionDone(tx)",
    "queue revision conflict": "failure.name = 'QueueConflictError'",
    "critical quota recovery": "async function runCriticalStorageWrite(operation)",
    "bounded image cache": "const IMAGE_CACHE_LIMIT = 160;",
    "bounded remote playlist cache": "const REMOTE_PLAYLIST_CACHE_LIMIT = 12;",
}

for label, snippet in required_html.items():
    require(snippet in HTML, f"missing {label}: {snippet}")

for label, snippet in required_app.items():
    require(snippet in APP, f"missing {label}: {snippet}")

boot_order = [
    APP.index("await loadDefaultPlaylist();"),
    APP.index("setupServiceWorkerUpdates();", APP.index("await loadDefaultPlaylist();")),
    APP.index("initCanvasRenderers();", APP.index("await loadDefaultPlaylist();")),
    APP.index("setupMediaSessionHandlers();", APP.index("await loadDefaultPlaylist();")),
    APP.index("markCPlayerReady();", APP.index("await loadDefaultPlaylist();")),
]
require(boot_order == sorted(boot_order) and len(set(boot_order)) == len(boot_order), "app-ready signal precedes required boot work")

require('<script type="module">' not in HTML, "main app module is still inline")
require("from './core-utils.js';" in APP and "./js/core-utils.js" not in APP, "app module import path is invalid")
require("self.loadPlaylist();" not in APP, "mobile search still uses the window self object")
require("mob-search-img-${song.id}" not in APP, "external song id is still interpolated into mobile HTML")
require(APP.count("const RECENT_HISTORY_KEY = 'cp_recent_history';") == 1, "recent history key is duplicated")
require(APP.count("localStorage.") == 3, "production localStorage access bypasses the safe storage boundary")
require((ROOT / "playlist.js").is_file(), "optional playlist.js hook is missing")
require((ROOT / "js" / "app.js").is_file(), "production app module is missing")
require((ROOT / "js" / "core-utils.js").is_file(), "core utility module is missing")
require((ROOT / "tests" / "core-utils.test.mjs").is_file(), "core utility tests are missing")
require("user-scalable=no" not in HTML and "maximum-scale" not in HTML, "viewport still blocks browser zoom")

require("cplayer5-v59-storage-resilience" in SW, "service worker cache version is not updated")
require("'./js/app.js'" in SW, "production app module is not precached")
require("./js/core-utils.js" in SW, "core utility module is not precached")
require("./css/tailwind.css" in SW and "./js/tailwindcss.js" not in SW, "service worker Tailwind cache entry is stale")
require("cacheCoreAssets" in SW and "new Request(new URL(asset, self.registration.scope)" in SW, "core cache refresh is not explicit")
require("const COVER_CACHE_LIMIT = 160;" in SW, "cover cache has no bounded limit")
require("k.startsWith('cplayer5-') && k !== CACHE_NAME" in SW, "cache cleanup is not scoped to this app")
require("event.request.mode === 'navigate'" in SW, "navigation fallback is missing")
require("isAppShellNavigation(url)" in SW, "navigation cache writes are not limited to the app shell")
require("url.pathname === scope.pathname" in SW, "app shell navigation does not recognize the scoped root")
fetch_handler = SW[SW.index("self.addEventListener('fetch'"):]
keyed_network_branch = fetch_handler.find("url.searchParams.has('apikey')")
known_api_branch = fetch_handler.find("url.hostname === 'api.chksz.top'")
first_cache_lookup = fetch_handler.find("caches.open(CACHE_NAME)")
require(
    0 <= keyed_network_branch < known_api_branch < first_cache_lookup,
    "keyed and known ChKSz API requests must bypass every fetch-handler cache lookup",
)
require("isDynamicMusicApi(url)" in fetch_handler, "key-free dynamic music API requests are not network-only")
require("caches.match(" not in SW, "service worker cache reads escape the current app cache namespace")
image_branch = SW.find("url.hostname.includes('music.126.net') && url.pathname.match")
cdn_network_branch = SW.find("url.hostname.includes('music.126.net'))")
require(image_branch >= 0 and cdn_network_branch > image_branch, "cover cache branch is shadowed by CDN network branch")

require(MANIFEST.get("start_url") == "./index.html", "manifest start_url changed unexpectedly")
require(any(icon.get("src") == "img/icon.png" for icon in MANIFEST.get("icons", [])), "PNG app icon is missing")
require("超清母带" not in MANIFEST.get("description", ""), "manifest still overstates playback quality")
require(PACKAGE.get("scripts", {}).get("build:css") == "tailwindcss -c tailwind.config.cjs -i css/tailwind.input.css -o css/tailwind.css --minify", "Tailwind build script changed unexpectedly")
require(PACKAGE.get("scripts", {}).get("build:pages") == "node scripts/build-pages-artifact.mjs", "Pages artifact build command is missing")
require(PACKAGE.get("devDependencies", {}).get("tailwindcss") == "3.4.17", "Tailwind version is not pinned")
require(PACKAGE.get("devDependencies", {}).get("acorn") == "8.15.0", "Acorn parser version is not pinned")
require(PACKAGE.get("devDependencies", {}).get("parse5") == "7.3.0", "parse5 version is not pinned")
require(PACKAGE.get("scripts", {}).get("verify") == "node scripts/run-quality-gate.mjs", "unified quality gate is missing")
require(PACKAGE.get("scripts", {}).get("test:e2e") == "playwright test", "browser regression command is missing")
require(PACKAGE.get("scripts", {}).get("check:repo") == "node scripts/check-repository-state.mjs", "repository hygiene command is missing")
require(PACKAGE.get("scripts", {}).get("check:rollback") == "node scripts/check-rollback-target.mjs", "rollback compatibility command is missing")
require(PACKAGE.get("engines", {}).get("node") == ">=22", "Node support floor must match CI")
playwright_version = PACKAGE.get("devDependencies", {}).get("@playwright/test", "")
require(bool(re.fullmatch(r"\d+\.\d+\.\d+", playwright_version)), "Playwright must use an exact pinned version")
require(PACKAGE.get("devDependencies", {}).get("@axe-core/playwright") == "4.10.2", "Axe Playwright version is not pinned")
require((ROOT / "tailwind.config.cjs").is_file(), "Tailwind config is missing")
require((ROOT / "css" / "tailwind.input.css").is_file(), "Tailwind source CSS is missing")
tailwind_css = ROOT / "css" / "tailwind.css"
require(tailwind_css.is_file() and tailwind_css.stat().st_size > 0, "generated Tailwind CSS is missing")
tailwind_config = (ROOT / "tailwind.config.cjs").read_text(encoding="utf-8")
tailwind_input = (ROOT / "css" / "tailwind.input.css").read_text(encoding="utf-8")
require(
    all(path in tailwind_config for path in ("'./index.html'", "'./playlist-downloader.html'", "'./js/app.js'")),
    "Tailwind content scan is incomplete",
)
require("@tailwind base;" in tailwind_input and "@tailwind utilities;" in tailwind_input, "Tailwind source directives are incomplete")
require('href="css/tailwind.css"' in HTML and 'js/tailwindcss.js' not in HTML, "main page still uses runtime Tailwind")
require('href="css/tailwind.css"' in DOWNLOADER and 'cdn.tailwindcss.com' not in DOWNLOADER, "downloader still uses Play CDN")

deployment_assets = [
    "index.html", "playlist-downloader.html", "playlist.js", "manifest.json", "sw.js",
    "css", "fonts", "img", "js", "webfonts",
]
require("path: output/pages" in WORKFLOW, "Pages upload does not use the verified output directory")
require(not re.search(r"^\s*path:\s+\.\s*$", WORKFLOW, flags=re.MULTILINE), "Pages still uploads the repository root")
require("quality:" in WORKFLOW and "needs: quality" in WORKFLOW, "Pages deploy is not gated by quality checks")
require("npm ci" in WORKFLOW and "playwright install --with-deps chromium" in WORKFLOW, "CI browser dependencies are not reproducible")
require("npm run verify" in WORKFLOW, "CI does not run the unified quality gate")
quality_job = WORKFLOW[WORKFLOW.index("  quality:"):WORKFLOW.index("  deploy:")]
deploy_job = WORKFLOW[WORKFLOW.index("  deploy:"):]
require("actions/upload-pages-artifact@v3" in quality_job, "quality job does not upload its verified Pages artifact")
require("actions/upload-pages-artifact" not in deploy_job, "deploy job rebuilds or uploads a second artifact")
require("actions/checkout" not in deploy_job and "Prepare Pages artifact" not in deploy_job, "deploy job still reconstructs the site")
require("cp index.html" not in WORKFLOW and "$RUNNER_TEMP/cplayer-pages" not in WORKFLOW, "workflow still owns a duplicate shell allowlist")
for asset in deployment_assets:
    require(f"'{asset}'" in PAGES_BUILDER, f"Pages builder is missing {asset}")
    require((ROOT / asset).exists(), f"Pages staging source is missing {asset}")
require("assertSafeOutputDirectory" in PAGES_BUILDER and "output', 'pages'" in PAGES_BUILDER,
        "Pages builder does not guard its repository-owned output directory")
require("PAGE_FILES" in PAGES_BUILDER and "PAGE_DIRECTORIES" in PAGES_BUILDER,
        "Pages artifact allowlist has no single owner")
require(not (ROOT / "_headers").exists(), "unsupported Pages _headers file is still present")

required_ignore_rules = [
    "/.agents/skills/*", "/.claude/", "/.codex/", "/.trellis/config.yaml",
    "/.trellis/scripts/*", "!/.trellis/scripts/get_context.py", "/.trellis/spec/",
    "output/playwright/", "/output/pages/",
]
for rule in required_ignore_rules:
    require(rule in GITIGNORE, f"missing local runtime ignore rule: {rule}")
require("api.chksz.top" in README, "README does not document the upstream API dependency")
require("Service Worker 的缓存修订号" in README, "README does not explain version semantics")
require("npm run verify" in README, "README does not document the release quality gate")
require("apikey" in README and "localStorage" in README, "README does not explain API key storage and transport")
require("Node.js 22" in README and "output/pages" in README, "README does not document the supported runtime and exact Pages artifact")
require("npm run check:rollback --" in README and "DB v4" in README, "README does not document the safe rollback guard")

api_endpoints = set(re.findall(r"ChKSzAPI\.buildUrl\('(/163_[a-z]+)'", APP))
require(api_endpoints == {"/163_search", "/163_music", "/163_lyric", "/163_playlist"}, "not every ChKSz endpoint uses the central URL builder")
require("search.set('apikey', key)" in APP, "API key is not appended through URLSearchParams")
require("writeLocalStorage('cp_api_key', key)" in APP, "API key is not persisted from runtime input")
require("removeLocalStorage('cp_api_key')" in APP, "API key reset is missing")
production_source = "\n".join((HTML, APP, DOWNLOADER, SW, CORE_UTILS))
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
require("PW_WEB_ROOT" in PLAYWRIGHT and "PW_WEB_ROOT" in TEST_SERVER and "webRoot" in TEST_SERVER,
        "release browser tests do not serve the selected Pages artifact root")
require("serviceWorkers: 'block'" in SEARCH_E2E and "page.route" in SEARCH_E2E, "search API mock can be bypassed by the Service Worker")
require("navigator.serviceWorker.controller" in SHELL_E2E and "setOffline(true)" in SHELL_E2E, "offline shell browser contract is incomplete")
require("external app module loads once as JavaScript" in SHELL_E2E and "transferSize" in SHELL_E2E, "app module resource boundary is not tested")
require("Service-Worker-Allowed" in TEST_SERVER and "tests/e2e/fixtures/sw-old.js" in TEST_SERVER, "old Worker root-scope permission is not isolated to the test server")
require("cplayer5-test-old" in OLD_SW_FIXTURE and "self.clients.claim()" in OLD_SW_FIXTURE, "old Worker fixture does not establish an active prior installation")
for snippet in ["OLD_WORKER_PATH", "controller?.scriptURL", "UNRELATED_CACHE_NAME", "setOffline(true)", "readQueueRecord", "'/js/app.js'"]:
    require(snippet in SW_UPDATE_E2E, f"service worker upgrade browser contract is missing: {snippet}")
for snippet in ["randomUUID", "/manifest.json?apikey=", "cache.put", ".delete(url)", "caches.match(url)"]:
    require(snippet in SW_KEY_CACHE_E2E, f"service worker key-cache browser contract is missing: {snippet}")
require("/__test__/" in TEST_SERVER and "testDynamicApiSequence" in TEST_SERVER,
        "test server does not provide controlled successful dynamic API responses")
for snippet in ["PUBLIC_PATHS", "PRIVATE_PATHS", "serviceWorker.ready", "setOffline(true)"]:
    require(snippet in RELEASE_ARTIFACT_E2E, f"Pages artifact browser contract is missing: {snippet}")
require("serviceWorkers: 'block'" in STORAGE_RESILIENCE_E2E and "CPlayer5DB" in STORAGE_RESILIENCE_E2E,
        "storage resilience browser tests do not isolate the real storage boundary")
require(E2E_HELPERS.count("indexedDB.open('CPlayer5DB', 4)") >= 2,
        "browser storage helpers do not use the current database version")
for snippet in [
    "installRuntimeProbes", "PageTransitionEvent('pagehide'", "removeSongFromQueue",
    "system play resumes committed song A", "ended committed media",
    "autoplay rejection after a source switch", "explicit clear-queue command",
    "seekbackward", "seekforward", "currentTimeAssignments", "loadCalls", "webglDrawCalls",
    "installAnimationFrameProbe", "setTestDocumentVisibility",
]:
    require(snippet in RUNTIME_RESILIENCE_E2E, f"runtime resilience browser contract is missing: {snippet}")
require("document.documentElement.dataset.cplayerReady === 'true'" in E2E_HELPERS,
        "browser readiness helper does not use the explicit app signal")
require("readMainAudioProbe" in PLAYBACK_ERROR_E2E and "querySelector('audio')" not in PLAYBACK_ERROR_E2E,
        "playback failure test does not inspect the real Audio boundary")
for snippet in ["AxeBuilder", "element.inert", "ArrowRight", "keyboard-progress.wav", "songRequests"]:
    require(snippet in RESPONSIVE_E2E, f"responsive accessibility browser contract is missing: {snippet}")
require("tests/e2e" not in WORKFLOW and "tests/e2e" not in PAGES_BUILDER,
        "test-only Worker/server files must not enter the Pages artifact")
for gate_step in ["build:css", "test:unit", "check:module", "check:sw", "check:features", "audit", "build:pages", "test:e2e", "check:repo"]:
    require(gate_step in QUALITY_GATE, f"quality gate is missing step: {gate_step}")
require("PW_WEB_ROOT" in QUALITY_GATE and "output', 'pages'" in QUALITY_GATE,
        "quality gate does not run browser regression from the Pages artifact")
for snippet in [
    "runGit(['diff', '--check']", "runGit(['diff', '--cached', '--check']",
    "--name-only", "--diff-filter=ACMRT", "ls-files", "--others", "encoding: null",
    "UTF-8 BOM is not allowed", "extra blank line at EOF",
]:
    require(snippet in REPOSITORY_CHECK, f"repository hygiene boundary is missing: {snippet}")
for snippet in [
    "from 'acorn'", "from 'parse5'", "extractDatabaseVersion", "sourceKind",
    "collectHtmlScripts", "GLOBAL_OBJECT_REFERENCE", "INDEXED_DB_REFERENCE",
    "mode: 'handler'", "javascript:", "srcdoc", "childDocuments", "classicScope",
    "execution === 'defer'", "execution === 'async'", "CALLABLE_REFERENCE",
    "promiseExecutors", "importScripts", "LOCATION_REFERENCE",
    "invalidatePatternBindings", "functionBoundary", "uncertain", "TryStatement",
    "WithStatement", "bindingKinds", "nearestVarScope", "globalObjectPropertyName",
    "from './build-pages-artifact.mjs'", "PAGE_DIRECTORIES", "PAGE_FILES",
    "ImportExpression", "isLocalModuleSpecifier", "documentCodeEntryName",
    "walkPatternExpressions", "predeclareConstants", "globalThis", "readCurrentDatabaseVersion",
    "readTargetDatabaseVersion", "ls-tree", "javascriptUrlSource", "globalObjectScope",
    "unstableBindings", "discoverUnstableGlobalBindings", "globalObjectMutationEntryName",
    "StaticBlock", "executionMode", "isDeployableArtifactPath",
    "listCurrentDeployablePaths", "normalizeLocalScriptPath",
    "assertRollbackVersion", "rev-parse", "runGit(['show'", "targetVersion < currentVersion",
]:
    require(snippet in ROLLBACK_CHECK, f"rollback schema guard is missing: {snippet}")

legacy_names = [
    "dedup_detail.py", "dedupe_recent.py", "find_cycle.py", "find_manage.py", "find_vars.py",
    "fix_dup2.py", "inspect_search.py", "patch_search_fix.py", "wire_recent_builtin.py",
]
require(all(not (ROOT / name).exists() for name in legacy_names), "legacy debug scripts still pollute the root")

badge = re.search(r'id="buildBadge"[^>]*>(v\d+)', HTML)
require(badge, "build badge is missing or malformed")
require("CPlayer 5 • 当前构建见左下角" in HTML, "settings version text is misleading")
require("classifyPlaybackQuality" in APP and "renderPlaybackQuality" in APP, "truthful quality display is not wired")
require("quality-unknown" in HTML and "音质确认中" in APP, "quality loading state is missing")
require("dom.qualityBadge.textContent = '💎JyMaster';" not in APP, "quality badge still claims master before verification")
require("level: typeof d.level === 'string' ? d.level : null" in APP, "requested quality still masquerades as API metadata")
require("document.querySelectorAll('#qualityBadge, #mobileQualityBadge')" in APP, "quality state is not rendered to both layouts")
require("超清母带" not in production_source, "UI still guarantees master-quality playback")
require("音质未标注" in README, "README does not explain unverified quality metadata")
require("const PLAYBACK_SESSION_KEY = 'cp_playback_session';" in APP, "playback resume storage is missing")
require("normalizePlaybackSession" in APP and "preparePlaybackResume" in APP, "playback resume is not wired")
require("getSafePlaybackResumeTime" in APP, "safe playback resume boundary is not wired")
require("savePlaybackSession('timeupdate', false)" in APP, "playback progress is not throttled through the shared saver")
require('id="sleepTimerSelect"' in HTML and "setupSleepTimerUI" in APP, "sleep timer controls are missing")
require("classifyPlaybackFailure(error, navigator.onLine !== false)" in APP, "playback failure feedback is not classified")
require("播放器不会绕过浏览器限制自动发声" in README, "resume autoplay limitation is undocumented")
require(APP.count("renderSearchRecoveryState") >= 3, "desktop and mobile search retry states are not shared")
require("重试搜索：" in APP and "当前已离线" in APP, "search retry accessibility or offline copy is missing")

print("stability checks: passed")
print("build badge:", badge.group(1))
print("core assets:", len(re.findall(r"^  './", SW, flags=re.MULTILINE)))
print("playlist hook:", (ROOT / "playlist.js").stat().st_size, "bytes")
