from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
for k in ["cyclePlayMode","PLAY_MODES","updatePlayModeUI","mPlayModeBtn"]:
 print(k, c.count(k), c.find(k))
i=c.find("cyclePlayMode")
print(c[i-400:i+800] if i>0 else "none")
