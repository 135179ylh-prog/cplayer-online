import sys, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TASKS = ROOT / ".trellis" / "tasks"

def read(name):
    p = TASKS / name
    return p.read_text(encoding="utf-8") if p.exists() else ""

mode = sys.argv[1] if len(sys.argv) > 1 else "default"

if mode == "phase":
    print("=== Current Phase ===")
    print(read("implementation-plan.md"))
elif mode == "packages":
    print("=== Packages ===")
    print("index.html, sw.js, manifest.json, .trellis/tasks/")
else:
    print("=== AGENTS.md ===")
    print((ROOT / "AGENTS.md").read_text(encoding="utf-8") if (ROOT / "AGENTS.md").exists() else "")
    print("\n=== Workflow ===")
    print((ROOT / ".trellis" / "workflow.md").read_text(encoding="utf-8") if (ROOT / ".trellis" / "workflow.md").exists() else "")
    print("\n=== PRD ===")
    print(read("prd.md"))
