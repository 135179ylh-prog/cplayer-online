from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
for k in ["vsCreateItem","mCreateItem","js-add-playlist","settingsModal","newUserPlaylistName","createUserPlaylistBtn","createPlaylistInModalBtn","openAddToPlaylistModal"]:
 print(k, c.count(k), c.find(k))
print("==== settings modal ====")
i=c.find('id="settingsModal"')
print(c[i:i+1200] if i>0 else "none")
