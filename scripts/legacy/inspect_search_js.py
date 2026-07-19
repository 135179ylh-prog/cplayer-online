from pathlib import Path
c=Path("index.html").read_text(encoding="utf-8")
for k in ["searchButton","searchInput.addEventListener","addEventListener('click'","performSearch","doSearch","searchMusic","163_search","renderSearchResults","searchResults.innerHTML"]:
 print(k, c.count(k), c.find(k))
