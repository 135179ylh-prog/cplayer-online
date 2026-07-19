from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
for k in ["refreshUserPlaylistLibrary","userPlaylistLibrary","loadUserPlaylistIntoQueue","listUserPlaylists","deleteUserPlaylist","userPlaylistModal","playlistSourceCard","clearQueueBtn","handleSongEnd","playSongAtIndex","loadAndPlaySong","currentQueue","saveCurrentQueue"]:
 print(k, c.count(k), c.find(k))
print("==== library ====")
i=c.find("async function refreshUserPlaylistLibrary"); print(c[i:i+1200] if i>0 else "none")
