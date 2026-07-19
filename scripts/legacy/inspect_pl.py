from pathlib import Path
c = Path("index.html").read_text(encoding="utf-8")
for k in ["userPlaylistLibrary","refreshUserPlaylistLibrary","userPlaylistModal","userPlaylistList","recent","history","playHistory","exportPlaylist","importPlaylist","USER_PL_PREFIX","listUserPlaylists"]:
    print(k, c.count(k), c.find(k))
print("==== library area ====")
i = c.find('id="userPlaylistLibrary"')
print(c[i-300:i+300] if i>0 else "none")
print("==== listUserPlaylists ====")
i = c.find("async function listUserPlaylists")
print(c[i:i+700] if i>0 else "none")
