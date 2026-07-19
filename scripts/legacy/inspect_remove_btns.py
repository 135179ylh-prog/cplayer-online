from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
# find desktop remove button block in vsCreateItem
i=c.find("js-remove-queue flex-none w-8 h-8")
print("desktop idx", i)
print(c[i-200:i+300] if i>0 else "none")
print("==== mobile ====")
j=c.find("js-remove-queue flex-none w-12 h-9")
print("mobile idx", j)
print(c[j-200:j+300] if j>0 else "none")
