from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")


def main() -> int:
    scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", HTML)
    if not scripts:
        raise AssertionError("no inline script blocks found")

    module_script = max(scripts, key=len)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".mjs", delete=False) as tmp:
            tmp.write(module_script)
            tmp_path = Path(tmp.name)

        result = subprocess.run(
            ["node", "--check", str(tmp_path)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="")
        if result.returncode != 0:
            return result.returncode
    finally:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)

    print("module syntax: passed")
    print("RECENT_HISTORY_KEY count", module_script.count("const RECENT_HISTORY_KEY = 'cp_recent_history';"))
    print("script size", len(module_script))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
