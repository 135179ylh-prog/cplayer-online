from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
for k in ["playModeBtn","playMode","mClearQueueBtn","mobileSheet","mobileUI","closeSheetBtn","mPlayMode"]:
 print(k, c.count(k), c.find(k))
print("==== playModeBtn ====")
i=c.find('id="playModeBtn"'); print(c[i-300:i+500] if i>0 else "none")
print("==== mClearQueueBtn ====")
i=c.find('id="mClearQueueBtn"'); print(c[i-300:i+300] if i>0 else "none")
