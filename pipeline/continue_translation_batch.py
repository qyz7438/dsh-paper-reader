"""Continue the complete scoped queue only after the active PDF trial passes."""
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    while (ROOT / "runner.lock").exists():
        time.sleep(5)
    manifest = json.loads((ROOT / "translation_manifest.json").read_text(encoding="utf-8"))
    if manifest["status"] != "limited_run_finished" or any(r["status"] in {"translation_failed", "review_attention"} for r in manifest["papers"]):
        raise RuntimeError("PDF trial did not pass; complete queue remains stopped with recorded evidence")
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("run_translation_batch.py")), "run"])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
