from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "js" / "app.js"


def main() -> int:
    if not APP.is_file():
        raise AssertionError("production app module is missing: js/app.js")

    module_script = APP.read_text(encoding="utf-8")
    result = subprocess.run(
        ["node", "--check", str(APP)],
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

    print("module syntax: passed")
    print("module path: js/app.js")
    print("RECENT_HISTORY_KEY count", module_script.count("const RECENT_HISTORY_KEY = 'cp_recent_history';"))
    print("script size", len(module_script))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
