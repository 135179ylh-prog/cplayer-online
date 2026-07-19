from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
for k in ["currentIndex","playlist =","let playlist","var playlist","const playlist","currentIndex ="]:
 print(k, c.count(k), c.find(k))
i=c.find("let playlist")
if i<0: i=c.find("var playlist")
if i<0: i=c.find("const playlist")
print("playlist decl idx", i)
print(c[i-200:i+400] if i>0 else "none")
