"""Use the existing persistent bridge with a separate allowed Plus auth home."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = Path(r"E:\.config\llm-wiki\bilibili-296-codex")
SOURCE = Path(r"E:\CLI\llm-wiki\scripts\codex_translate_shim_v2.py")


def save_json(path, value):
    staged = path.with_suffix(path.suffix + ".staging")
    staged.write_text(json.dumps(value, indent=2), encoding="utf-8")
    json.loads(staged.read_text(encoding="utf-8"))
    os.replace(staged, path)


def main():
    PRIVATE.mkdir(parents=True, exist_ok=True)
    target = PRIVATE / "auth.json"
    if not target.is_file():
        raise RuntimeError("E scoped auth home is not seeded; refusing to read or switch the desktop auth home")
    auth = json.loads(target.read_text(encoding="utf-8"))
    token = auth["tokens"]["id_token"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
    email = claims.get("email")
    plan = claims.get("https://api.openai.com/auth", {}).get("chatgpt_plan_type")
    if email in {"plus-account-a@example.com", "plus-account-b@example.com"} and plan == "plus":
        pass
    elif email == "fallback-account@example.com" and plan == "pro":
        proof = json.loads((ROOT / "plus_exhaustion_proof.json").read_text(encoding="utf-8"))
        import time
        if time.time() - proof["at_epoch"] > 180 or set(proof["accounts"]) != {"account-id-a", "account-id-b"}:
            raise RuntimeError("m.e exhaustion proof missing/stale")
        for account in proof["accounts"].values():
            if account.get("usageError") or account.get("authRefreshBlocked") or not any(
                account.get("usage", {}).get(k, {}).get("usedPercent", -1) >= 100
                and account["usage"][k].get("resetAt", 0) > time.time() for k in ("fiveHour", "oneWeek")):
                raise RuntimeError("m.e requires both allowed Plus accounts at verified 100%")
    else:
        raise RuntimeError("isolated bridge account is not authorized")
    (PRIVATE / "config.toml").write_text('model = "gpt-6-luna"\nmodel_provider = "openai"\nmodel_reasoning_effort = "low"\n', encoding="utf-8")
    text = SOURCE.read_text(encoding="utf-8")
    changes = {
        'MODEL = "gpt-5.6-luna"': 'MODEL = "gpt-6-luna"',
        'LISTEN = ("127.0.0.1", 4210)': 'LISTEN = ("127.0.0.1", 4212)',
        'POOL_SIZE = 6': 'POOL_SIZE = 12',
        'MAX_CONCURRENT = 6': 'MAX_CONCURRENT = 12',
        'CODEX_HOME = r"E:\\.codex"': "CODEX_HOME = " + repr(str(PRIVATE)),
        'def chat(self, text: str) -> str:': 'def chat(self, text: str, effort: str = "low") -> str:',
        '"effort": "low",': '"effort": effort,',
        'def chat(self, sys_txt: str | None, user_txt: str) -> str:': 'def chat(self, sys_txt: str | None, user_txt: str, effort: str = "low") -> str:',
        'out = pt.chat(prompt)': 'out = pt.chat(prompt, effort)',
        'txt = self.shim.chat(sys_txt, user_txt)': 'effort = body.get("reasoning_effort", "low")\n            if effort not in ("low", "medium", "high"):\n                raise ValueError("effort must be low, medium or high")\n            txt = self.shim.chat(sys_txt, user_txt, effort)',
        '"and line structure. Do not add explanations."': '"and line structure. Do not add explanations. When explicitly asked for TASK: TRANSLATION_AUDIT, TASK: PAPER_SCORING, or TASK: PAPER_REPORT, instead perform the requested bounded audit, scoring, or source-grounded report and output the requested JSON or Markdown result string."',
        '        self._id += 1\n        rid = self._id': '        with self._write_lock:\n            self._id += 1\n            rid = self._id',
        'effort=low,': 'effort=low (audit=high),',
        '    def do_GET(self):\n': '    def do_GET(self):\n        if self.path.rstrip("/").endswith("/account"):\n            try:\n                account = self.shim.conn.request("account/read", {"refreshToken": False}, timeout=30)\n                limits = self.shim.conn.request("account/rateLimits/read", {}, timeout=30)\n                self._send_json(200, {"account": account, "limits": limits})\n            except Exception as e:\n                self._send_json(503, {"error": str(e)[:200]})\n            return\n',
    }
    for old, new in changes.items():
        if old not in text:
            raise RuntimeError(f"bridge source changed; patch not applicable: {old[:50]}")
        text = text.replace(old, new)
    startup_sample = text[text.index("    txt = shim.chat(None,"):text.index("    Handler.shim = shim")]
    text = text.replace(startup_sample, "")
    runtime = ROOT / "runtime"
    for directory in (runtime / "shim-tmp", runtime / "shim-cache", runtime / "bridge-cwd"):
        directory.mkdir(parents=True, exist_ok=True)
    os.environ.update({"TEMP": str(runtime / "shim-tmp"), "TMP": str(runtime / "shim-tmp"),
                       "TMPDIR": str(runtime / "shim-tmp"), "XDG_CACHE_HOME": str(runtime / "shim-cache")})
    namespace = {"__name__": "scoped_bridge", "__file__": str(SOURCE)}
    exec(compile(text, str(SOURCE), "exec"), namespace)
    namespace["SCRATCH"] = runtime / "bridge-cwd"
    namespace["SCRATCH"].mkdir(exist_ok=True)
    save_json(ROOT / "bridge_policy.json", {"pid": os.getpid(), "source": str(SOURCE),
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(), "port": 4212,
        "model": "gpt-6-luna", "translation_effort": "low", "audit_effort": "high",
        "auth_home": str(PRIVATE), "account_plan": plan, "email": email})
    json.loads((ROOT / "bridge_policy.json").read_text(encoding="utf-8"))
    namespace["main"]()


if __name__ == "__main__":
    main()
