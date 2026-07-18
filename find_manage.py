from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
i=c.find('data-act="detail"')
print(i)
print(c[i:i+400])
