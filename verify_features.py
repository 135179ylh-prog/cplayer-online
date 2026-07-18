from pathlib import Path
c = Path("index.html").read_text(encoding="utf-8")
keys = [
    "data-act=\"detail\"",
    "openPlaylistDetailModal",
    "pushRecentHistory",
    "renderRecentHistory",
    "exportUserPlaylists",
    "importUserPlaylists",
    "recentHistoryList",
    "clearRecentBtn",
    "exportPlaylistsBtn",
    "importPlaylistsInput",
]
for k in keys:
    print(k, c.count(k))
i = c.find("async function refreshUserPlaylistLibrary")
print("=== library row ===")
print(c[i:i+900] if i > 0 else "none")
i2 = c.find("id=\"recentHistoryList\"")
print("recentHistoryList in HTML:", i2 > 0)
