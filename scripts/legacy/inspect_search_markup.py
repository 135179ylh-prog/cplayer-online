from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
i=c.find('id="searchInput"')
print(c[i-400:i+400])
print("--- results ---")
j=c.find('id="searchResults"')
print(c[j-300:j+300])
