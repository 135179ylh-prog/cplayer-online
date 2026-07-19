from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
for k in ["function handleSearch","handleSearch()","searchInput","searchResults","performSearch","doSearch","renderSearchResults","searchForm"]:
 print(k, c.count(k), c.find(k))
print("==== handleSearch ====")
i=c.find("function handleSearch"); print(c[i:i+1400] if i>0 else "none")
