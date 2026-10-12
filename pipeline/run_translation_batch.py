"""Scoped BabelDOC mono translations, gated review, and reader integration."""
from __future__ import annotations

import argparse
import collections
import concurrent.futures
import copy
import ctypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request

import pymupdf
import psutil

ROOT = Path(__file__).resolve().parents[1]
COLLECTION = ROOT.parent / "paper-channel-check" / "paper_collection.json"
VAULT = Path(r"E:\CLI\llm-wiki")
READER = Path(r"E:\DSH1\paper-reader")
OUTPUT = VAULT / "pdfs" / "B站-CV-可解释性与特征融合-镜像"
# Scoped credentials are declared below; the C: profile is not an auth home.
VENV = Path(r"C:\Users\<you>\.config\llm-wiki\venv\Scripts")
AUTH_HOME = Path(r"E:\.config\llm-wiki\bilibili-296-codex")
PRIVATE = AUTH_HOME
PORT = 4212
ENDPOINT = f"http://127.0.0.1:{PORT}/v1/chat/completions"
ALLOWED_EMAIL = "plus-account-a@example.com"
PLUS_ACCOUNTS = {"account-id-a": "plus-account-a@example.com", "account-id-b": "plus-account-b@example.com"}
FALLBACK_ACCOUNT = "fallback-account-id"
MANIFEST = ROOT / "translation_manifest.json"
RUNTIME = ROOT / "runtime"
WORK_ROOT = ROOT / "work"
DISK_FLOOR_BYTES = 10 * 1024 ** 3
WORKER_RESERVE_BYTES = 1024 ** 3
MEMORY_FLOOR_BYTES = 1 * 1024 ** 3  # 2026-10-07: user going to sleep, host otherwise idle — keep only 1GiB free per user instruction
MEMORY_WORKER_RESERVE_BYTES = 2 * 1024 ** 3  # 2026-10-07: measured babeldoc peak ~1.8GiB (bridge/worker logs); user ordered higher load
ADMISSION_QUOTA_CACHE_SECONDS = 60
WORKER_IDLE_TIMEOUT_SECONDS = 5400
WORKER_MAX_RUNTIME_SECONDS = 24 * 3600
WORKER_PROGRESS_POLL_SECONDS = 15
_ADMISSION_QUOTA_CACHE = None
NODE_STAGING = ROOT.parent / "node-staging"
CARD_INDEX = NODE_STAGING / "manifests" / "paper_node_map.json"
CARD_HELPER = NODE_STAGING / "scripts" / "card_updates.py"
CARD_GUARD = Path(os.environ.get("BILIBILI_CARD_PROMOTION_GUARD", ROOT.parent / "guard.json"))
CARD_RECEIPTS = ROOT / "mirror-card-receipts"
LEGACY_AUDIT_BINDINGS = ROOT / "audit_legacy_bindings.json"
PROJECT_RANKINGS = ROOT / "project-relevance" / "project_rankings.json"


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_suffix(path.suffix + ".staging")
    with staged.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    load(staged)
    for attempt in range(8):
        try:
            os.replace(staged, path)
            break
        except PermissionError as exc:
            if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 7:
                raise
            time.sleep(0.05 * (attempt + 1))
    if load(path) != value:
        raise RuntimeError("atomic JSON publication validation mismatch")


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def prioritize_by_project_rank(rows):
    """Use the latest project ranking, never the frozen original score snapshot."""
    if not PROJECT_RANKINGS.is_file():
        raise RuntimeError("latest project rankings missing")
    ranking = load(PROJECT_RANKINGS)
    priorities = {row["key"]: (row.get("new_rank", float("inf")), -row.get("score_lower_bound", -1))
                  for row in ranking.get("papers", [])}
    return sorted(rows, key=lambda row: (*priorities.get(row["key"], (float("inf"), 0)),
                                         not row.get("reader_pinned", False), row["key"]))


def runtime_environment(paper_key):
    """Keep transient translation data on E: while the installed venv remains on C:."""
    paths = {"tmp": RUNTIME / "tmp", "cache": RUNTIME / "cache",
             "babeldoc_cache": RUNTIME / "babeldoc-cache", "logs": ROOT / "logs"}
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", paper_key):
        raise ValueError("paper key is not safe for a worker cache path")
    env.update({"TRANSLATION_RUNTIME_ROOT": str(RUNTIME), "TRANSLATION_PAPER_KEY": paper_key,
                "TEMP": str(paths["tmp"]),
                "TMP": str(paths["tmp"]), "TMPDIR": str(paths["tmp"]),
                "XDG_CACHE_HOME": str(paths["cache"]),
                "BABELDOC_CACHE_DIR": str(paths["babeldoc_cache"]),
                "BABELDOC_CACHE_PATH": str(paths["babeldoc_cache"])})
    return env


def validate_worker_counts(requested_workers, existing_workers):
    """Reject ambiguous counts before using total concurrent-worker budgets."""
    if type(requested_workers) is not int or requested_workers < 0:
        raise ValueError("requested workers must be a nonnegative integer")
    if type(existing_workers) is not int or existing_workers < 0:
        raise ValueError("existing workers must be a nonnegative integer")


def resource_gate(manifest, requested_workers, allow_zero=False, existing_workers=0):
    """Reserve E: for existing work and any proposed additional workers."""
    validate_worker_counts(requested_workers, existing_workers)
    usage = shutil.disk_usage(ROOT)
    allowed = min(requested_workers, max(0, (usage.free - DISK_FLOOR_BYTES) // WORKER_RESERVE_BYTES - existing_workers))
    if allowed < requested_workers:
        required_free = DISK_FLOOR_BYTES + (existing_workers + requested_workers) * WORKER_RESERVE_BYTES
        reclaim_attached_work(manifest, max(0, required_free - usage.free), limit=8)
        usage = shutil.disk_usage(ROOT)
        allowed = min(requested_workers, max(0, (usage.free - DISK_FLOOR_BYTES) // WORKER_RESERVE_BYTES - existing_workers))
    receipt = {"at": now(), "free_bytes": usage.free, "disk_floor_bytes": DISK_FLOOR_BYTES,
               "per_worker_reserve_bytes": WORKER_RESERVE_BYTES, "requested_workers": requested_workers,
               "allowed_workers": allowed, "existing_workers": existing_workers,
               "total_workers_after_admission": existing_workers + allowed,
               "requested_total_workers": existing_workers + requested_workers}
    manifest.setdefault("resource_gates", []).append(receipt)
    if allowed < 1 and not allow_zero:
        manifest.update(status="waiting_for_e_disk", resource_gate=receipt)
        save(MANIFEST, manifest)
        raise RuntimeError("E: disk floor prevents another translation worker")
    return int(allowed)


class PERFORMANCE_INFORMATION(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_uint32), ("CommitTotal", ctypes.c_size_t),
                ("CommitLimit", ctypes.c_size_t), ("CommitPeak", ctypes.c_size_t),
                ("PhysicalTotal", ctypes.c_size_t), ("PhysicalAvailable", ctypes.c_size_t),
                ("SystemCache", ctypes.c_size_t), ("KernelTotal", ctypes.c_size_t),
                ("KernelPaged", ctypes.c_size_t), ("KernelNonpaged", ctypes.c_size_t),
                ("PageSize", ctypes.c_size_t), ("HandleCount", ctypes.c_uint32),
                ("ProcessCount", ctypes.c_uint32), ("ThreadCount", ctypes.c_uint32)]


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                ("ullAvailExtendedVirtual", ctypes.c_uint64)]


def windows_memory_snapshot():
    """Read host-level physical and commit headroom; never inspect other processes."""
    if os.name != "nt":
        raise RuntimeError("translation memory gate requires Windows host metrics")
    info = PERFORMANCE_INFORMATION()
    info.cb = ctypes.sizeof(info)
    if not ctypes.WinDLL("psapi", use_last_error=True).GetPerformanceInfo(ctypes.byref(info), info.cb):
        raise OSError(ctypes.get_last_error(), "GetPerformanceInfo")
    global_memory = MEMORYSTATUSEX()
    global_memory.dwLength = ctypes.sizeof(global_memory)
    if not ctypes.WinDLL("kernel32", use_last_error=True).GlobalMemoryStatusEx(ctypes.byref(global_memory)):
        raise OSError(ctypes.get_last_error(), "GlobalMemoryStatusEx")
    page = int(info.PageSize)
    return {"at": now(), "physical_available_bytes": int(info.PhysicalAvailable) * page,
            "physical_total_bytes": int(info.PhysicalTotal) * page,
            "commit_total_bytes": int(info.CommitTotal) * page,
            "commit_limit_bytes": int(info.CommitLimit) * page,
            "commit_available_bytes": (int(info.CommitLimit) - int(info.CommitTotal)) * page,
            "commit_peak_bytes": int(info.CommitPeak) * page,
            "memory_load_percent": int(global_memory.dwMemoryLoad),
            "pagefile_available_bytes": int(global_memory.ullAvailPageFile)}


def memory_gate(manifest, requested_workers, allow_zero=False, existing_workers=0):
    """Count existing workers against both physical and commit reserves."""
    validate_worker_counts(requested_workers, existing_workers)
    snapshot = windows_memory_snapshot()
    physical_workers = max(0, (snapshot["physical_available_bytes"] - MEMORY_FLOOR_BYTES) // MEMORY_WORKER_RESERVE_BYTES)
    commit_workers = max(0, (snapshot["commit_available_bytes"] - MEMORY_FLOOR_BYTES) // MEMORY_WORKER_RESERVE_BYTES)
    allowed = min(requested_workers, max(0, physical_workers - existing_workers),
                  max(0, commit_workers - existing_workers))
    receipt = {**snapshot, "requested_workers": requested_workers, "allowed_workers": int(allowed),
               "memory_floor_bytes": MEMORY_FLOOR_BYTES, "per_worker_reserve_bytes": MEMORY_WORKER_RESERVE_BYTES,
               "reason": "host physical and commit headroom including existing workers",
               "existing_workers": existing_workers,
               "total_workers_after_admission": existing_workers + allowed,
               "requested_total_workers": existing_workers + requested_workers}
    manifest.setdefault("memory_gates", []).append(receipt)
    if allowed < 1 and not allow_zero:
        manifest.update(status="waiting_for_memory", memory_gate=receipt)
        save(MANIFEST, manifest)
        raise RuntimeError("Windows physical/commit headroom prevents another translation worker")
    return int(allowed)


def cpu_gate(manifest, requested_workers):
    """Measure host load over five seconds; reserve two logical cores per new PDF."""
    ceiling = 75.0
    cores_per_worker = 2
    try:
        logical = psutil.cpu_count()
        if type(logical) is not int or logical < 1:
            raise RuntimeError('logical CPU count unavailable')
        started = time.monotonic()
        used = psutil.cpu_percent(interval=5)
        elapsed = time.monotonic() - started
        if type(used) not in (int, float) or not math.isfinite(used) or not 0 <= used <= 100 or elapsed < 5:
            raise RuntimeError('CPU sample unavailable or invalid')
        reserve_percent = 100.0 * cores_per_worker / logical
        allowed = min(requested_workers, max(0, int((ceiling - used) // reserve_percent)))
        receipt = {'at': now(), 'used_percent': used, 'sample_seconds': elapsed, 'logical_cpus': logical,
                   'admission_ceiling_percent': ceiling, 'logical_cores_per_new_worker': cores_per_worker,
                   'requested_workers': requested_workers, 'allowed_workers': allowed}
    except Exception as exc:
        allowed = 0
        receipt = {'at': now(), 'requested_workers': requested_workers, 'allowed_workers': 0,
                   'error': str(exc), 'reason': 'CPU sampling failed; no new worker admitted'}
    manifest['cpu_gate'] = receipt
    return allowed


def audit_receipt_for(row):
    """Return an exact persisted pass receipt rather than trusting a mutable row alone."""
    key = row["key"]
    source_hash = row.get("source_sha256")
    output_hash = (row.get("validation") or {}).get("sha256")
    attempt_id = row.get("translation_attempt_id")
    for audit_path in sorted(ROOT.glob("audit_*.json")):
        try:
            audit = load(audit_path)
        except (OSError, json.JSONDecodeError):
            continue
        bindings = {item.get("key"): item for item in audit.get("bindings", [])}
        review = next((item for item in audit.get("result", {}).get("papers", []) if item.get("key") == key), None)
        binding = bindings.get(key)
        if (review and review.get("verdict") == "pass" and binding and
                binding.get("source_sha256") == source_hash and binding.get("output_sha256") == output_hash and
                binding.get("attempt_id") == attempt_id):
            return audit_path
    if not LEGACY_AUDIT_BINDINGS.is_file():
        return None
    try:
        legacy = load(LEGACY_AUDIT_BINDINGS)
    except (OSError, json.JSONDecodeError):
        return None
    for binding in legacy.get("bindings", []):
        audit_path = Path(binding.get("audit_path", ""))
        if (binding.get("key") == key and binding.get("source_sha256") == source_hash and
                binding.get("output_sha256") == output_hash and audit_path.is_file() and
                sha(audit_path) == binding.get("audit_sha256")):
            return audit_path
    return None


def is_reparse_point(path):
    attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & 0x400)


def generated_work_path(key):
    candidate = (WORK_ROOT / key).resolve()
    root = WORK_ROOT.resolve()
    if root not in candidate.parents or candidate == root:
        raise ValueError("generated work candidate escapes translation work root")
    if not candidate.exists():
        return candidate
    if is_reparse_point(candidate) or any(is_reparse_point(part) for part in candidate.parents if part != root):
        raise ValueError("generated work candidate contains a reparse point")
    return candidate


def work_tree_is_safe(work):
    for parent, directories, files in os.walk(work, followlinks=False):
        for name in directories + files:
            if is_reparse_point(Path(parent) / name):
                return False
    return True


def no_live_owned_worker(work):
    """Fail closed if a recorded worker survives or an owned worker has open files."""
    import psutil
    state = work / "worker_state.json"
    if state.is_file():
        try:
            pid = load(state).get("worker_pid")
            if pid is not None and psutil.pid_exists(int(pid)):
                return False
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
    for process in psutil.process_iter(["pid", "cmdline"]):
        try:
            command = " ".join(process.info.get("cmdline") or [])
            if "bounded_babeldoc_worker.py" not in command and "run_translation_batch.py" not in command:
                continue
            for opened in process.open_files():
                if Path(opened.path).resolve().is_relative_to(work):
                    return False
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            return False
    return True


def reader_attachment_matches(row, output):
    try:
        for name in ("papers.json", "papers.v2.json"):
            papers = load(READER / name)["papers"]
            item = next(paper for paper in papers if paper["slug"] == row["slug"])
            if Path(item.get("pdfZh", "")).resolve() != output.resolve():
                return False
    except (OSError, KeyError, StopIteration, json.JSONDecodeError):
        return False
    return True


def reclaim_attached_work(manifest, needed_bytes, limit=2):
    """Keep work inputs for repair evidence; cleanup uses reviewed exact lists."""
    return 0


def refs_filter(source):
    """Omit only subsequent bibliography pages; retain mixed and appendix pages."""
    skipped, active = [], False
    with pymupdf.open(source) as doc:
        total = len(doc)
        for i, page in enumerate(doc):
            text = page.get_text()
            lines = text.splitlines()
            heading = any(re.fullmatch(r"\s*(?:\d+[. ]+)?(?:references|bibliography)\s*", x, re.I) for x in lines)
            appendix = any(re.match(r"\s*(?:[A-Z][. ]+)?(?:appendix|supplementary|supplement)\b", x, re.I) for x in lines)
            if appendix:
                active = False
            if active and not appendix:
                years = len(re.findall(r"\b(?:19|20)\d{2}\b", text))
                entries = len(re.findall(r"(?m)^\s*\[\d+\]", text))
                has_figure = bool(re.search(r"(?im)^\s*(?:figure|table)\s+\d+", text))
                if years >= 5 and entries >= 4 and not has_figure:
                    skipped.append(i + 1)
                else:
                    active = False
            if heading:
                active = True
    kept = [i for i in range(1, total + 1) if i not in skipped]
    return total, skipped, ",".join(map(str, kept))


def validate(source, mirror):
    with pymupdf.open(source) as a, pymupdf.open(mirror) as b:
        if len(a) != len(b):
            raise ValueError("mirror page count differs from original")
        changed = [i + 1 for i in range(len(a)) if any(abs(x-y) > 0.1 for x, y in zip(a[i].rect, b[i].rect))]
        if changed:
            raise ValueError(f"page dimensions differ: {changed}")
        cjk = sum(len(re.findall(r"[\u4e00-\u9fff]", page.get_text())) for page in b)
        if cjk < 50:
            raise ValueError("mirror contains fewer than 50 extracted Chinese characters")
        return {"pages": len(a), "same_page_dimensions": True, "chinese_characters": cjk,
                "sha256": sha(mirror), "bytes": Path(mirror).stat().st_size}


def prepare():
    if MANIFEST.exists():
        raise RuntimeError("manifest already exists; prepare cannot overwrite task progress")
    collection = load(COLLECTION)
    index = {p["slug"]: p for p in load(READER / "papers.json")["papers"]}
    records = []
    for paper in collection["papers"]:
        row = {"key": paper["key"], "title": paper["title"], "video_ids": paper["video_ids"],
               "slug": paper.get("reader_slug"), "status": "pending"}
        if not paper.get("local_pdf"):
            row.update(status="source_unavailable", reason="PanoEarth: IEEE returned HTML/418; no public original PDF obtained")
            records.append(row)
            continue
        source = Path(paper["local_pdf"]["path"])
        if sha(source) != paper["local_pdf"]["sha256"]:
            raise ValueError(f"original hash mismatch: {paper['key']}")
        reader_row = index[row["slug"]]
        if Path(reader_row["pdfEn"]).resolve() != source.resolve():
            raise ValueError(f"reader original mismatch: {row['slug']}")
        pages, skipped, selection = refs_filter(source)
        row.update(source=str(source), source_sha256=paper["local_pdf"]["sha256"], pages=pages,
                   reference_pages_kept_english=skipped, translate_pages=selection,
                   output=str(OUTPUT / (source.stem + "_镜像.pdf")),
                   reader_score=reader_row.get("score"), reader_pinned=bool(reader_row.get("pinned")))
        candidates = [reader_row.get("pdfZh"), row["output"]]
        for candidate in filter(None, candidates):
            if Path(candidate).is_file():
                try:
                    checked = validate(source, candidate)
                    row.update(output=str(candidate), status="reused_pending_review", validation=checked)
                    break
                except Exception as exc:
                    row.setdefault("existing_mirror_rejections", []).append({"path": str(candidate), "reason": str(exc)})
        records.append(row)
    records.sort(key=lambda r: (r.get("status") == "source_unavailable", not r.get("reader_pinned", False), -(r.get("reader_score") or 0)))
    manifest = {"created_at": now(), "session": "session_dbc85ff1-54ce-43cf-bfab-3b60eb8c024e",
                "videos": len(collection["videos"]), "unique_papers": len(records), "available_originals": sum("source" in r for r in records),
                "policy": {"model": "gpt-6-luna", "translation_effort": "medium", "audit_effort": "high",
                           "mode": "mono", "workers": 8, "audit_every": 8, "timeout_seconds": 5400,
                           "llm_concurrent_requests": 12, "max_pages_per_part": 10,
                           "cpu_limits": {"ort_intra": 1, "ort_inter": 1, "spinning": False, "opencv": 1, "blas": 1, "layout_pool": 2, "priority": "below_normal"},
                           "quota_threshold": 100, "allowed_plus": PLUS_ACCOUNTS,
                           "fallback": "fallback-account@example.com only after verified exhaustion of both allowed Plus accounts",
                           "references": "only confidently identified bibliography-only pages remain English; no pages removed"},
                "status": "prepared", "papers": records}
    save(MANIFEST, manifest)
    (ROOT / "translation_queue.txt").write_text("\n".join(r["source"]+"|"+r["translate_pages"] for r in records if "source" in r)+"\n", encoding="utf-8")
    return manifest


def account_usage(account_id):
    policy = load(ROOT / "bridge_policy.json")
    expected = PLUS_ACCOUNTS.get(account_id, "fallback-account@example.com")
    if policy.get("email", ALLOWED_EMAIL) == expected:
        native = None
        last_error = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/account", timeout=65) as response:
                    native = json.loads(response.read())
                break
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(3)
        if native is None:
            raise RuntimeError(f"native quota read failed after 3 attempts: {last_error}")
        identity = native["account"]["account"]
        if identity.get("email") != expected or identity.get("planType") != ("plus" if account_id in PLUS_ACCOUNTS else "pro"):
            raise RuntimeError("native bridge identity/plan mismatch")
        limits = native["limits"].get("rateLimitsByLimitId", {}).get("codex") or native["limits"]["rateLimits"]
        normalized = {}
        for original, translated in (("primary", "fiveHour"), ("secondary", "oneWeek")):
            value = limits.get(original)
            if not isinstance(value, dict):
                raise RuntimeError("native quota fields unavailable")
            percentage, reset = value.get("usedPercent"), value.get("resetsAt")
            if (type(percentage) not in (int, float) or not math.isfinite(percentage) or not 0 <= percentage <= 100 or
                    type(reset) not in (int, float) or not math.isfinite(reset) or reset <= time.time()):
                raise RuntimeError("native quota fields unavailable")
            normalized[translated] = {"usedPercent": value["usedPercent"], "resetAt": value["resetsAt"], "windowSeconds": value["windowDurationMins"]*60}
        return {"email": expected, "planType": identity["planType"], "usage": normalized,
                "usageError": None, "authRefreshBlocked": False, "source": "owned app-server account/rateLimits/read"}
    result = subprocess.run([r"E:\npm-global\ctc.cmd", "usage", account_id, "--json"], capture_output=True, text=True, encoding="utf-8", timeout=60)
    if result.returncode:
        raise RuntimeError("account usage lookup failed; no account substitution performed")
    accounts = json.loads(result.stdout)
    account = accounts[0]
    if account.get("email") != expected:
        raise RuntimeError("account metadata identity mismatch")
    return {k: account.get(k) for k in ("email", "planType", "usage", "usageError", "authRefreshBlocked", "authRefreshError")}


def exhausted(account):
    if account.get("usageError") or account.get("authRefreshBlocked") or not account.get("usage"):
        return False
    return any(isinstance(account["usage"].get(k), dict)
               and account["usage"][k].get("usedPercent", -1) >= 100
               and account["usage"][k].get("resetAt", 0) > time.time()
               for k in ("fiveHour", "oneWeek"))


def rotate_bridge(account_id, proof=None):
    """Export only into isolated auth home; never switch the desktop account."""
    if account_id == FALLBACK_ACCOUNT:
        if proof is None or not all(exhausted(a) for a in proof.values()) or set(proof) != set(PLUS_ACCOUNTS):
            raise RuntimeError("m.e requires fresh exhaustion evidence for every allowed Plus account")
        save(ROOT / "plus_exhaustion_proof.json", {"at_epoch": time.time(), "accounts": proof})
    policy = load(ROOT / "bridge_policy.json")
    import psutil
    process = psutil.Process(policy["pid"])
    if "start_scoped_translation_shim.py" not in " ".join(process.cmdline()):
        raise RuntimeError("bridge PID ownership changed; refusing process control")
    export = AUTH_HOME / "account-export.json"
    result = subprocess.run([r"E:\npm-global\ctc.cmd", "export", str(export), "--account", account_id, "--json"],
                            capture_output=True, text=True, encoding="utf-8", timeout=60)
    if result.returncode:
        raise RuntimeError("isolated account export failed")
    account = load(export)["accounts"][0]
    expected_email = PLUS_ACCOUNTS.get(account_id, "fallback-account@example.com")
    if account["email"] != expected_email:
        raise RuntimeError("exported account identity mismatch")
    save(AUTH_HOME / "next-auth.json", account["authJson"])
    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.replace(AUTH_HOME / "next-auth.json", AUTH_HOME / "auth.json")
    with (ROOT / "bridge.log").open("a", encoding="utf-8") as out, (ROOT / "bridge_error.log").open("a", encoding="utf-8") as err:
        new_process = subprocess.Popen([str(VENV / "python.exe"), str(ROOT / "scripts" / "start_scoped_translation_shim.py")], stdout=out, stderr=err)
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=2):
                return
        except Exception:
            if new_process.poll() is not None:
                raise RuntimeError("new owned bridge failed to start")
            time.sleep(1)
    raise RuntimeError("new owned bridge startup timeout")


def ensure_quota(manifest):
    while True:
        policy = load(ROOT / "bridge_policy.json")
        active_id = next((k for k,v in PLUS_ACCOUNTS.items() if v == policy.get("email", ALLOWED_EMAIL)), FALLBACK_ACCOUNT)
        account = account_usage(active_id)
        manifest["active_account"] = {"id": active_id, "email": account["email"], "plan": account["planType"]}
        manifest["usage"] = account
        if account.get("usageError") or account.get("authRefreshBlocked"):
            raise RuntimeError("active account authorization/usage error; not quota exhaustion")
        if not exhausted(account):
            manifest["status"] = "running"
            save(MANIFEST, manifest)
            return
        proof = {k: account_usage(k) for k in PLUS_ACCOUNTS}
        available = [k for k,a in proof.items() if not a.get("usageError") and not a.get("authRefreshBlocked") and a.get("usage") and not exhausted(a)]
        if available:
            rotate_bridge(available[0])
            continue
        if active_id != FALLBACK_ACCOUNT and all(exhausted(a) for a in proof.values()):
            fallback = account_usage(FALLBACK_ACCOUNT)
            if not fallback.get("usageError") and not exhausted(fallback):
                rotate_bridge(FALLBACK_ACCOUNT, proof)
                continue
        limits = account["usage"]
        exceeded = [limits[k] for k in ("fiveHour", "oneWeek") if isinstance(limits.get(k), dict) and limits[k].get("usedPercent", -1) >= 100]
        manifest.update(status="waiting_for_quota_reset", quota_resume_at=max(v["resetAt"] for v in exceeded),
                        plus_exhaustion_evidence=proof, fallback_blocked_reason="all allowed Plus accounts must have verified 100% usage; authorization failures do not qualify")
        save(MANIFEST, manifest)
        time.sleep(min(60, max(1, manifest["quota_resume_at"] - time.time())))


def model_call(prompt, effort="high"):
    body = json.dumps({"model": "gpt-6-luna", "reasoning_effort": effort,
                       "messages": [{"role": "user", "content": prompt}]}).encode("utf-8")
    request = urllib.request.Request(ENDPOINT, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=380) as response:
        return json.loads(response.read())["choices"][0]["message"]["content"]


def paper_work_dir(row, proposed):
    work = Path(proposed).resolve()
    paper_root = (WORK_ROOT / row["key"]).resolve()
    if not work.is_relative_to(paper_root):
        raise RuntimeError("worker path escapes the paper work root")
    return work


def mono_candidates(work, source):
    return sorted({path.resolve() for path in list(work.glob(source.stem + ".*.mono.pdf")) +
                   list(work.glob(source.stem + ".mono.pdf"))})


def adoption_receipt_path(row):
    attempt = re.sub(r"[^A-Za-z0-9._-]", "_", str(row.get("translation_attempt_id") or row["key"]))
    return ROOT / "adoption-receipts" / f"{row['key']}.{attempt}.json"


def adopt_identity_matches(adoption, source, work):
    receipt_path = Path(adoption.get("identity_receipt", ""))
    if not receipt_path.is_file():
        return False
    try:
        receipt = load(receipt_path)
    except (OSError, json.JSONDecodeError):
        return False
    return (receipt.get("pid") == adoption.get("pid") and receipt.get("create_time") == adoption.get("create_time") and
            receipt.get("source_sha256") == adoption.get("source_sha256") == sha(source) and
            Path(receipt.get("source", "")).resolve() == source.resolve() and
            Path(receipt.get("work_dir", "")).resolve() == work.resolve())


def finalize_mono(row, source, output, work, adoption=None):
    if output.exists():
        checked = validate(source, output)
        origin = "existing_output"
    else:
        candidates = mono_candidates(work, source)
        if len(candidates) != 1:
            raise RuntimeError(f"expected one full mono PDF, got {len(candidates)}")
        validate(source, candidates[0])
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists():
            raise RuntimeError("output appeared during translation; refusing overwrite")
        shutil.copy2(candidates[0], output)
        checked, origin = validate(source, output), str(candidates[0])
    if adoption:
        receipt = {"at": now(), "key": row["key"], "pid": adoption["pid"], "create_time": adoption["create_time"],
                   "source": str(source), "source_sha256": row["source_sha256"], "work_dir": str(work),
                   "output": str(output), "output_sha256": checked["sha256"], "origin": origin}
        save(adoption_receipt_path(row), receipt)
        row["adoption_receipt"] = str(adoption_receipt_path(row))
    row.update(status="translated_pending_review", validation=checked, completed_at=now())
    return row


class TranslationWorkerTimeout(RuntimeError):
    pass


def worker_progress_snapshot(row, work):
    """Observe completed parts and this paper's durable translation cache."""
    cache = RUNTIME / "translation-caches" / row["key"]
    paths = [cache / "cache.v1.db", cache / "cache.v1.db-wal"]
    paths.extend(work.glob("processing/*/part_*_output/*.mono.pdf"))
    observed = []
    for path in paths:
        try:
            info = path.stat()
        except FileNotFoundError:
            continue
        if info.st_size:
            observed.append((str(path), info.st_size, info.st_mtime_ns))
    return tuple(sorted(observed))


def wait_for_translation_progress(process, row, work):
    """Give each active translation 90 idle minutes, with a 24-hour total cap."""
    started = __import__("datetime").datetime.fromisoformat(row["started_at"]).timestamp()
    wall_now, monotonic_now = time.time(), time.monotonic()
    original_age = max(0.0, wall_now - started)
    absolute_deadline = monotonic_now + max(0.0, WORKER_MAX_RUNTIME_SECONDS - original_age)
    snapshot = worker_progress_snapshot(row, work)
    newest = max((entry[2] / 1e9 for entry in snapshot), default=started)
    last_activity = monotonic_now - max(0.0, wall_now - min(wall_now, max(started, newest)))
    while True:
        # A completed process wins over either timeout at the boundary.
        try:
            return process.wait(timeout=0)
        except (subprocess.TimeoutExpired, psutil.TimeoutExpired):
            pass
        current = worker_progress_snapshot(row, work)
        now_monotonic = time.monotonic()
        if current != snapshot:
            new_or_changed = [entry for entry in current if entry not in snapshot]
            if new_or_changed:
                last_activity = now_monotonic
            snapshot = current
        idle_remaining = WORKER_IDLE_TIMEOUT_SECONDS - (now_monotonic - last_activity)
        total_remaining = absolute_deadline - now_monotonic
        if total_remaining <= 0:
            raise TranslationWorkerTimeout("exceeded 24-hour total runtime cap")
        if idle_remaining <= 0:
            raise TranslationWorkerTimeout("had no completed-part or translation-cache progress for 90 minutes")
        try:
            return process.wait(timeout=min(WORKER_PROGRESS_POLL_SECONDS, idle_remaining, total_remaining))
        except (subprocess.TimeoutExpired, psutil.TimeoutExpired):
            continue


def adopt_running_worker(row, source, output):
    adoption = row["adopt_running_worker"]
    if adoption.get("source_sha256") != row.get("source_sha256") or sha(source) != row.get("source_sha256"):
        raise RuntimeError("adopted worker source hash mismatch")
    work = paper_work_dir(row, adoption.get("work_dir", ""))
    try:
        process = psutil.Process(int(adoption["pid"]))
    except psutil.NoSuchProcess:
        if not adopt_identity_matches(adoption, source, work):
            raise RuntimeError("adopted worker exited without a validated main identity receipt")
        return finalize_mono(row, source, output, work, adoption)
    if abs(process.create_time() - float(adoption["create_time"])) > 0.001:
        raise RuntimeError("adopted worker creation time mismatch")
    command = process.cmdline()
    def exact_option(option, expected):
        positions = [index for index, value in enumerate(command) if value == option]
        return len(positions) == 1 and positions[0] + 1 < len(command) and command[positions[0] + 1] == str(expected)
    if (not any("bounded_babeldoc_worker.py" in item for item in command) or
            not exact_option("--files", source) or not exact_option("--output", work) or
            not exact_option("--working-dir", work / "processing")):
        raise RuntimeError("adopted worker command/source/work mismatch")
    try:
        started = __import__("datetime").datetime.fromisoformat(row["started_at"]).timestamp()
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError("adopted worker lacks parseable original start time") from exc
    try:
        wait_for_translation_progress(process, row, work)
    except TranslationWorkerTimeout as exc:
        raise RuntimeError(f"adopted worker {exc}; process intentionally not killed") from exc
    return finalize_mono(row, source, output, work, adoption)


def translate(row):
    source, output = Path(row["source"]), Path(row["output"])
    if row.get("adopt_running_worker"):
        return adopt_running_worker(row, source, output)
    if row["status"] in {"reused_pending_review", "translated_pending_review"}:
        return row
    if output.exists():
        raise RuntimeError("recovery mirror target already exists; refusing model work or overwrite")
    row["translation_attempt_id"] = f"{row['key']}:{time.time_ns()}"
    work = paper_work_dir(row, row.get("work_dir") or (WORK_ROOT / row["key"]))
    work.mkdir(parents=True, exist_ok=True)
    logfile = ROOT / "logs" / (row["key"] + ".log")
    logfile.parent.mkdir(exist_ok=True)
    cmd = [str(VENV / "python.exe"), str(ROOT / "scripts" / "bounded_babeldoc_worker.py"), "--files", str(source), "--lang-in", "en", "--lang-out", "zh",
           "--output", str(work), "--working-dir", str(work / "processing"), "--no-dual", "--qps", "2",
           "--no-auto-extract-glossary", "--openai", "--openai-model", "gpt-6-luna",
           "--openai-base-url", f"http://127.0.0.1:{PORT}/v1", "--openai-api-key", "codex-shim",
           "--pages", row["translate_pages"], "--max-pages-per-part", "10"]
    if any(attempt.get("review", {}).get("verdict") == "revise" for attempt in row.get("attempt_history", []) if attempt.get("review")):
        cmd.append("--ignore-cache")
    row.update(status="translating", started_at=now(), log=str(logfile))
    with logfile.open("w", encoding="utf-8") as log:
        creationflags = subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0
        process = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT,
                                    creationflags=creationflags, env=runtime_environment(row["key"]))
        row["worker_pid"] = process.pid
        save(work / "worker_state.json", {"worker_pid": process.pid, "started_at": row["started_at"], "status": "translating"})
        try:
            rc = wait_for_translation_progress(process, row, work)
        except TranslationWorkerTimeout as exc:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                process.kill()
            process.wait()
            raise RuntimeError(f"BabelDOC {exc}; owned worker stopped") from exc
    if rc:
        raise RuntimeError(f"BabelDOC exit {rc}; see per-paper log")
    return finalize_mono(row, source, output, work)


def audit_samples(rows):
    samples = []
    for row in rows:
        pairs = []
        with pymupdf.open(row["source"]) as en, pymupdf.open(row["output"]) as zh:
            selection = [int(x)-1 for x in row["translate_pages"].split(",")]
            chosen = sorted(set([selection[0], selection[len(selection)//2], selection[-1]]))
            for i in chosen:
                # PDF insertion order can place repaired paragraphs after the
                # original page text. Keep the complete sampled pages so an
                # appended repair cannot disappear behind a prefix cutoff.
                pairs.append({"page": i+1, "en": en[i].get_text(sort=True), "zh": zh[i].get_text(sort=True)})
        samples.append({"key": row["key"], "title": row["title"], "samples": pairs})
    return samples


def audit_prompt(samples):
    return ('TASK: TRANSLATION_AUDIT. Do not translate the prompt. Review these paired English/Chinese PDF page extracts. '
               'Extraction order may differ. Identify substantive mistranslation, missing paragraphs, corrupted numbers/formulas, '
               'negation reversal, or unreadable Chinese. This is sampled review, not a claim of full-paper correctness. '
               'Keep embedded figure raster labels and unselected reference pages unchanged; their English text is not a defect. '
              'Score ONLY sampled translated text: fidelity 0-40, terminology 0-20, numbers_formulas 0-20, fluency 0-10. '
               'Return ONLY JSON {"papers":[{"key":"...","verdict":"pass|revise|unknown","fidelity":0,"terminology":0,"numbers_formulas":0,"fluency":0,"issues":["..."]}]}. '
               'Every supplied paper key must appear exactly once. An English title/author/reference or formula alone is not a defect. '
               + json.dumps(samples, ensure_ascii=False))


def parse_audit_result(raw, rows):
    payload = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        result = json.loads(payload)
        reviews = result["papers"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError(f"audit JSON/result shape invalid: {exc}") from exc
    if not isinstance(reviews, list):
        raise ValueError("audit papers is not a list")
    requested = [row["key"] for row in rows]
    returned = [review.get("key") if isinstance(review, dict) else None for review in reviews]
    if len(reviews) != len(requested) or len(set(returned)) != len(returned) or set(returned) != set(requested):
        raise ValueError("audit did not return exact batch keys")
    review_index = {review["key"]: review for review in reviews}
    for row in rows:
        reviewed = review_index[row["key"]]
        if type(reviewed.get("verdict")) is not str or reviewed["verdict"] not in {"pass", "revise", "unknown"}:
            raise ValueError("invalid review verdict")
        for field, maximum in (("fidelity", 40), ("terminology", 20), ("numbers_formulas", 20), ("fluency", 10)):
            if type(reviewed.get(field)) is not int or not 0 <= reviewed[field] <= maximum:
                raise ValueError("invalid quality score component")
        if not isinstance(reviewed.get("issues"), list) or not all(type(issue) is str for issue in reviewed["issues"]):
            raise ValueError("invalid review issues")
    return result, review_index


def apply_audit_reviews(rows, samples, review_index):
    sample_index = {sample["key"]: sample for sample in samples}
    for row in rows:
        reviewed = dict(review_index[row["key"]])
        reviewed["issues"] = list(reviewed["issues"])
        structure = 10 if row["validation"]["same_page_dimensions"] else 0
        score = structure + sum(reviewed[k] for k in ("fidelity", "terminology", "numbers_formulas", "fluency"))
        row["translation_quality"] = {"score": score, "structure": structure,
                                       "sampled_pages": [p["page"] for p in sample_index[row["key"]]["samples"]],
                                      "scope": "three sampled pages plus whole-PDF page count/dimensions; not full-text review"}
        if score < 80 or reviewed["fidelity"] < 32 or reviewed["numbers_formulas"] < 16:
            reviewed["verdict"] = "revise"
        row.update(review=reviewed, status="review_passed" if reviewed["verdict"] == "pass" else "review_attention")


def persist_audit(rows, result, number):
    bindings = []
    for row in rows:
        binding = {"key": row["key"], "attempt_id": row.get("translation_attempt_id", f"legacy-unbound:{row['key']}"),
                   "source_sha256": row["source_sha256"], "output_sha256": row["validation"]["sha256"]}
        bindings.append(binding)
    save(ROOT / f"audit_{number:03d}.json", {"at": now(), "model": "gpt-6-luna", "effort": "high",
                                                "result": result, "bindings": bindings})
    return {binding["key"]: binding for binding in bindings}


def bind_persisted_audit(rows, bindings):
    for row in rows:
        row.setdefault("translation_attempt_id", bindings[row["key"]]["attempt_id"])
        row["audit_binding"] = bindings[row["key"]]


def audit(rows, number):
    samples = audit_samples(rows)
    raw = model_call(audit_prompt(samples))
    raw_path = ROOT / f"audit_{number:03d}_raw.txt"
    raw_path.write_text(raw, encoding="utf-8")
    try:
        result, review_index = parse_audit_result(raw, rows)
    except ValueError as batch_error:
        fallback = {"at": now(), "batch_raw": str(raw_path), "batch_raw_sha256": sha(raw_path),
                    "batch_error": str(batch_error), "individual": []}
        valid_rows, valid_reviews, valid_indexes = [], [], []
        for row, sample in zip(rows, samples):
            individual_raw = model_call(audit_prompt([sample]))
            individual_path = ROOT / f"audit_{number:03d}_{row['key']}_raw.txt"
            individual_path.write_text(individual_raw, encoding="utf-8")
            try:
                individual_result, individual_index = parse_audit_result(individual_raw, [row])
            except ValueError as individual_error:
                receipt = {"at": now(), "key": row["key"], "batch_error": str(batch_error),
                           "individual_error": str(individual_error), "raw": str(individual_path),
                           "raw_sha256": sha(individual_path), "status": "review_attention"}
                save(ROOT / f"audit_{number:03d}_{row['key']}_invalid_receipt.json", receipt)
                row.update(status="review_attention", audit_error=receipt, review={"key": row["key"], "verdict": "unknown",
                                                                                       "issues": ["audit response invalid; paper quarantined"]})
                fallback["individual"].append({"key": row["key"], "status": "invalid", "receipt": receipt})
                continue
            valid_rows.append(row)
            valid_reviews.extend(individual_result["papers"])
            valid_indexes.append((row, sample, individual_index))
            fallback["individual"].append({"key": row["key"], "status": "valid", "raw": str(individual_path),
                                            "raw_sha256": sha(individual_path)})
        save(ROOT / f"audit_{number:03d}_fallback_receipt.json", fallback)
        if valid_rows:
            bindings = persist_audit(valid_rows, {"papers": valid_reviews}, number)
            for row, sample, individual_index in valid_indexes:
                apply_audit_reviews([row], [sample], individual_index)
            bind_persisted_audit(valid_rows, bindings)
        return
    bindings = persist_audit(rows, result, number)
    apply_audit_reviews(rows, samples, review_index)
    bind_persisted_audit(rows, bindings)


def card_update_module():
    if not CARD_HELPER.is_file():
        raise RuntimeError("card_update_helper_missing")
    spec = importlib.util.spec_from_file_location("bilibili_card_updates", CARD_HELPER)
    if spec is None or spec.loader is None:
        raise RuntimeError("card_update_helper_unloadable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def promoted_card_path(row):
    index = load(CARD_INDEX)
    record = next((item for item in index.get("records", []) if item.get("key") == row["key"]), None)
    if not record:
        raise RuntimeError("card_index_record_missing")
    path = Path(record.get("proposed_card") or record.get("existing_card") or "")
    cards_root = (VAULT / "_wiki" / "references" / "papers").resolve()
    resolved = path.resolve()
    if not path.is_file() or not resolved.is_relative_to(cards_root):
        raise RuntimeError("promoted_card_missing_or_outside_papers_root")
    return resolved


def record_card_mirror(row, payload):
    CARD_RECEIPTS.mkdir(parents=True, exist_ok=True)
    save(CARD_RECEIPTS / f"{row['key']}.json", payload)


def install_card_mirror(row):
    card = promoted_card_path(row)
    if not CARD_GUARD.is_file():
        raise RuntimeError("main_card_guard_missing")
    outcome = card_update_module().update_mirror(card, Path(row["output"]), guard_path=CARD_GUARD, key=row["key"])
    receipt = {"at": now(), "key": row["key"], "card": str(card), "mirror": row["output"],
               "guard": str(CARD_GUARD), "status": outcome}
    record_card_mirror(row, receipt)
    return receipt


def attach(rows):
    """Change only pdfZh; preserve existing index order, queue, read and pin state."""
    candidates = [r for r in rows if r["status"] == "review_passed"]
    if not candidates:
        return
    backup = ROOT / "reader-backups" / str(time.time_ns())
    backup.mkdir(parents=True)
    snapshots = {name: (READER / name).read_bytes() for name in ("papers.json", "papers.v2.json")}
    documents = {name: json.loads(content.decode("utf-8-sig")) for name, content in snapshots.items()}
    lookups = {name: {p["slug"]: p for p in doc["papers"]} for name, doc in documents.items()}
    viable = []
    for row in candidates:
        problem = None
        try:
            if sha(row["source"]) != row["source_sha256"]:
                problem = "original changed before reader integration"
        except Exception as exc:
            problem = f"source unreadable: {exc}"
        if problem is None:
            for name in documents:
                item = lookups[name].get(row["slug"])
                if item is None:
                    problem = f"slug absent from {name}"
                    break
                if Path(item["pdfEn"]).resolve() != Path(row["source"]).resolve():
                    problem = f"reader original mismatch in {name}"
                    break
                previous = row.get("prior_reader_mirror")
                if item.get("pdfZh") and Path(item["pdfZh"]).resolve() != Path(row["output"]).resolve() and item["pdfZh"] != previous:
                    problem = f"reader gained a different mirror in {name}; refusing overwrite"
                    break
        if problem is not None:
            row.setdefault("attempt_history", []).append({"at": now(), "kind": "attach_blocked", "reason": problem})
            row.update(status="review_attention", last_error="attach_blocked: " + problem)
            continue
        viable.append(row)
    if not viable:
        return
    for name, doc in documents.items():
        for row in viable:
            lookups[name][row["slug"]]["pdfZh"] = row["output"]
        (backup / name).write_bytes(snapshots[name])
    for name in snapshots:
        if (READER / name).read_bytes() != snapshots[name]:
            raise RuntimeError("reader index changed concurrently; no write performed")
    for name, doc in documents.items():
        if (READER / name).read_bytes() != snapshots[name]:
            raise RuntimeError("reader index changed before its sequential save")
        save(READER / name, doc)
    for row in viable:
        try:
            receipt = install_card_mirror(row)
        except Exception as exc:
            payload = {"at": now(), "key": row["key"], "mirror": row["output"],
                       "status": "reader_attached_card_pending", "error": str(exc)}
            record_card_mirror(row, payload)
            row.update(status="reader_attached_card_pending", card_mirror_error=str(exc), card_mirror_receipt=payload)
            continue
        row.update(status="attached", attached_at=now(), card_mirror_receipt=receipt)

def admission_quota_available(manifest):
    """Read the active native quota without rotating the bridge under live PDF workers."""
    global _ADMISSION_QUOTA_CACHE
    policy = load(ROOT / "bridge_policy.json")
    active_id = next((key for key, email in PLUS_ACCOUNTS.items() if email == policy.get("email", ALLOWED_EMAIL)), FALLBACK_ACCOUNT)
    policy_hash = sha(ROOT / 'bridge_policy.json')
    identity = (active_id, policy.get('email'), policy.get('pid'), policy_hash, PORT)
    cached = _ADMISSION_QUOTA_CACHE
    age = time.monotonic() - cached['at_monotonic'] if cached else float('inf')
    if cached and cached['identity'] == identity and 0 <= age < ADMISSION_QUOTA_CACHE_SECONDS and all(
            x.get('resetAt', 0) > time.time() for x in cached['account']['usage'].values()):
        account = copy.deepcopy(cached['account'])
        manifest['quota_admission'] = {'source': 'cached successful native Plus response', 'age_seconds': age,
                                       'ttl_seconds': ADMISSION_QUOTA_CACHE_SECONDS, 'bridge_policy_sha256': policy_hash}
    else:
        _ADMISSION_QUOTA_CACHE = None
        account = account_usage(active_id)
        if sha(ROOT / 'bridge_policy.json') != policy_hash or load(ROOT / 'bridge_policy.json') != policy:
            raise RuntimeError('bridge identity changed during native quota read')
        manifest['quota_admission'] = {'source': 'fresh native response', 'age_seconds': 0,
                                       'bridge_policy_sha256': policy_hash}
        windows_valid = all(type(account.get('usage', {}).get(window, {}).get('usedPercent')) in (int, float) and
                            math.isfinite(account['usage'][window]['usedPercent']) and 0 <= account['usage'][window]['usedPercent'] < 100 and
                            type(account['usage'][window].get('resetAt')) in (int, float) and
                            math.isfinite(account['usage'][window]['resetAt']) and account['usage'][window]['resetAt'] > time.time()
                            for window in ('fiveHour', 'oneWeek'))
        if (windows_valid and active_id in PLUS_ACCOUNTS and account.get('email') == PLUS_ACCOUNTS[active_id] == policy.get('email') and
                account.get('planType') == 'plus' and not account.get('usageError') and not account.get('authRefreshBlocked') and
                account.get('source') == 'owned app-server account/rateLimits/read' and account.get('usage') and not exhausted(account)):
            _ADMISSION_QUOTA_CACHE = {'identity': identity, 'at_monotonic': time.monotonic(), 'account': copy.deepcopy(account)}
    manifest["active_account"] = {"id": active_id, "email": account["email"], "plan": account["planType"]}
    manifest["usage"] = account
    if account.get("usageError") or account.get("authRefreshBlocked"):
        raise RuntimeError("active account authorization/usage error; not quota exhaustion")
    return not exhausted(account)


def harvest_finished(futures, completed):
    """The controller thread is the sole manifest-row writer for submitted tasks."""
    changed = False
    done, _ = concurrent.futures.wait(futures, timeout=0, return_when=concurrent.futures.FIRST_COMPLETED)
    for future in done:
        row, task = futures.pop(future)
        try:
            row.update(future.result())
            completed.append(row)
        except Exception as exc:
            retained = {field: task.get(field) for field in ("log", "started_at", "worker_pid", "translation_attempt_id")
                        if task.get(field) is not None}
            row.update(retained)
            row.setdefault("attempt_history", []).append({"at": now(), "kind": "worker_failure",
                                                             "attempt_id": task.get("translation_attempt_id"),
                                                             "log": task.get("log"), "error": str(exc)})
            row.update(status="translation_failed", error=str(exc), failed_at=now())
        changed = True
    return changed


def refresh_worker_states(futures):
    changed = False
    for pending_row, _ in futures.values():
        adopted_work = (pending_row.get("adopt_running_worker") or {}).get("work_dir")
        worker_state = Path(pending_row.get("work_dir") or adopted_work or (ROOT / "work" / pending_row["key"])) / "worker_state.json"
        if pending_row["status"] == "queued" and worker_state.is_file():
            pending_row.update(load(worker_state))
            changed = True
    return changed


def live_worker_reservations(manifest, futures):
    """Count queued futures plus identity-verified adopted processes outside them.

    A timeout changes the row status but does not release a live process's
    reservation. Inaccessible or mismatched live identities fail admission.
    """
    future_keys = {row["key"] for row, task in futures.values()}
    if len(future_keys) != len(futures):
        raise RuntimeError("duplicate document futures")
    live = {}
    rows_seen = set()
    for row in manifest["papers"]:
        key = row["key"]
        if key in rows_seen:
            raise RuntimeError("duplicate manifest document")
        rows_seen.add(key)
        adoption = row.get("adopt_running_worker")
        if not adoption or key in future_keys:
            continue
        pid, created = adoption.get("pid"), adoption.get("create_time")
        if (type(pid) is not int or pid <= 0 or type(created) not in (int, float)
                or not math.isfinite(created) or created <= 0):
            raise RuntimeError("invalid retained worker identity")
        try:
            process = psutil.Process(pid)
            if process.create_time() != created:
                continue  # Original identity exited; never operate on its reused PID.
            source = Path(row["source"])
            work = paper_work_dir(row, adoption["work_dir"])
            if (adoption.get("source_sha256") != row.get("source_sha256")
                    or not adopt_identity_matches(adoption, source, work)):
                raise RuntimeError("retained worker source/receipt mismatch")
            command = process.cmdline()
            receipt = load(adoption["identity_receipt"])
            if command != receipt.get("command"):
                raise RuntimeError("retained worker full argv drifted")
            def exact_option(option, expected):
                positions = [i for i, item in enumerate(command) if item == option]
                return (len(positions) == 1 and positions[0] + 1 < len(command)
                        and command[positions[0] + 1] == str(expected))
            worker_script = (ROOT / "scripts/bounded_babeldoc_worker.py").resolve()
            if (len(command) < 2 or Path(command[1]).resolve() != worker_script
                    or not exact_option("--files", source)
                    or not exact_option("--output", work)
                    or not exact_option("--working-dir", work / "processing")
                    or Path(process.cwd()).resolve() != (RUNTIME / "tmp").resolve()):
                raise RuntimeError("retained worker argv/cwd mismatch")
            identity = (pid, created)
            if identity in live:
                raise RuntimeError("same live worker claimed by multiple documents")
            live[identity] = key
        except psutil.NoSuchProcess:
            # Exit releases host reservation only; the failed row and artifacts
            # remain held for evidence-bound completion/recovery.
            continue
    return len(futures) + len(live)


def run(limit=None):
    manifest = load(MANIFEST)
    queue = prioritize_by_project_rank([row for row in manifest["papers"]
                                        if row["status"] in {"pending", "reused_pending_review", "translated_pending_review"}])
    if limit is not None:
        queue = queue[:limit]
    audit_number = len(list(ROOT.glob("audit_*_raw.txt")))
    completed, draining_for_quota, global_error, global_error_status = [], False, None, None
    configured_cap = manifest["policy"]["workers"]
    active_document_limit = int(manifest["policy"].get("rolling_active_document_limit", 4))
    if not 1 <= active_document_limit <= configured_cap:
        raise RuntimeError("rolling_active_document_limit must be within the configured worker cap")
    with concurrent.futures.ThreadPoolExecutor(max_workers=configured_cap) as executor:
        futures = {}
        adopted = [row for row in queue if row.get("adopt_running_worker")]
        if len(adopted) > active_document_limit:
            raise RuntimeError("handoff adoption count exceeds rolling active document limit")
        for row in adopted:
            queue.remove(row)
            task = dict(row)
            row["status"] = "adopting"
            futures[executor.submit(translate, task)] = (row, task)
        if adopted:
            save(MANIFEST, manifest)
        while queue or futures or completed:
            if harvest_finished(futures, completed):
                save(MANIFEST, manifest)
            if global_error is not None:
                if futures:
                    concurrent.futures.wait(futures, timeout=15, return_when=concurrent.futures.FIRST_COMPLETED)
                    if refresh_worker_states(futures):
                        save(MANIFEST, manifest)
                    continue
                try:
                    ensure_quota(manifest)
                except Exception as quota_error:
                    manifest.update(status="global_error_after_drain", error=str(quota_error), stopped_at=now())
                    save(MANIFEST, manifest)
                    raise
                manifest.update(status=global_error_status or "global_error_after_drain", error=str(global_error), stopped_at=now())
                save(MANIFEST, manifest)
                raise global_error
            if not futures and completed:
                try:
                    ensure_quota(manifest)
                except Exception as exc:
                    manifest.update(status="quota_or_rotation_stopped", error=str(exc), stopped_at=now())
                    save(MANIFEST, manifest)
                    raise
                draining_for_quota = False
            admitted = 0
            if queue and not draining_for_quota:
                # Decide whether host resources can accept work before querying quota.
                # Resource waits therefore do not hammer the native usage endpoint.
                existing_workers = live_worker_reservations(manifest, futures)
                requested = min(max(0, active_document_limit - existing_workers), len(queue))
                capacity = 0
                if requested:
                    try:
                        disk_allowed = resource_gate(manifest, requested, allow_zero=True, existing_workers=existing_workers)
                        memory_allowed = memory_gate(manifest, requested, allow_zero=True, existing_workers=existing_workers)
                        capacity = min(requested, disk_allowed, memory_allowed)
                        if capacity:
                            capacity = min(capacity, cpu_gate(manifest, capacity))
                    except Exception as exc:
                        global_error = exc
                        global_error_status = 'admission_gate_error_after_drain'
                        manifest.update(status='draining_after_global_error', error=str(exc), stopped_at=now())
                        save(MANIFEST, manifest)
                    else:
                        if capacity < 1:
                            manifest.update(status='waiting_for_admission_capacity', admission_wait_at=now(), admission_requested=requested)
                            save(MANIFEST, manifest)
                if capacity and global_error is None:
                    try:
                        if not futures:
                            ensure_quota(manifest)
                            draining_for_quota = False
                        elif not admission_quota_available(manifest):
                            draining_for_quota = True
                            manifest.update(status="draining_for_quota", quota_admission_paused_at=now())
                            save(MANIFEST, manifest)
                    except Exception as exc:
                        global_error = exc
                        global_error_status = "admission_quota_error_after_drain"
                        manifest.update(status="draining_after_global_error", error=str(exc), stopped_at=now())
                        save(MANIFEST, manifest)
                if not draining_for_quota and global_error is None:
                    # Quota reads can take seconds: refresh memory/disk before spawn.
                    if capacity:
                        try:
                            existing_workers = live_worker_reservations(manifest, futures)
                            capacity = min(capacity, max(0, active_document_limit - existing_workers))
                            admitted = min(capacity, resource_gate(manifest, capacity, allow_zero=True, existing_workers=existing_workers),
                                           memory_gate(manifest, capacity, allow_zero=True, existing_workers=existing_workers), cpu_gate(manifest, capacity))
                        except Exception as exc:
                            global_error = exc
                            global_error_status = 'admission_gate_error_after_drain'
                            manifest.update(status='draining_after_global_error', error=str(exc), stopped_at=now())
                            save(MANIFEST, manifest)
                    if admitted:
                        for _ in range(admitted):
                            row = queue.pop(0)
                            task = dict(row)
                            if row['status'] == 'pending':
                                row['status'] = 'queued'
                            futures[executor.submit(translate, task)] = (row, task)
                        manifest['status'] = 'running'
                        save(MANIFEST, manifest)
            # Refill happens before review. Review small groups so completed work
            # can be attached/reclaimed while other PDF workers remain active.
            if completed and not draining_for_quota and global_error is None:
                ready = completed[:3]
                try:
                    audit_number += 1
                    audit(ready, audit_number)
                    attach(ready)
                    del completed[:len(ready)]
                    manifest["quarantined_mirrors"] = [row["key"] for row in manifest["papers"] if row["status"] == "review_attention"]
                    save(MANIFEST, manifest)
                except Exception as exc:
                    global_error = exc
                    global_error_status = "audit_or_integration_stopped"
                    manifest.update(status="draining_after_global_error", error=str(exc), stopped_at=now())
                    save(MANIFEST, manifest)
                    continue
            if futures:
                concurrent.futures.wait(futures, timeout=15, return_when=concurrent.futures.FIRST_COMPLETED)
                if refresh_worker_states(futures):
                    save(MANIFEST, manifest)
            elif queue and (draining_for_quota or admitted < 1):
                # No submitted process is lost: wait for a fresh host/disk sample
                # rather than treating a temporary zero admission as a failure.
                time.sleep(15)
    counts = dict(collections.Counter(row["status"] for row in manifest["papers"]))
    manifest.update(status="limited_run_finished" if limit else "batch_finished", finished_at=now(), counts=counts)
    save(MANIFEST, manifest)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "run"])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--handoff-receipt", type=Path)
    args = parser.parse_args()
    if args.mode == "prepare":
        result = prepare()
        print(json.dumps({"records": len(result["papers"]), "counts": dict(collections.Counter(r["status"] for r in result["papers"]))}))
        return
    lock = ROOT / "runner.lock"
    if args.handoff_receipt:
        acquire_handoff_lock(lock, args.handoff_receipt)
    else:
        with lock.open("x", encoding="ascii") as stream:
            stream.write(str(os.getpid()))
    try:
        run(args.limit)
    finally:
        if lock.is_file() and lock.read_text(encoding="ascii").strip() == str(os.getpid()):
            lock.unlink()


def acquire_handoff_lock(lock, receipt_path):
    receipt_path = receipt_path.resolve()
    if not receipt_path.is_relative_to(ROOT.resolve()) or not receipt_path.is_file():
        raise RuntimeError("handoff receipt must be an existing file under translation root")
    receipt = load(receipt_path)
    required = {"old_controller_pid", "old_controller_create_time", "old_lock_sha256", "manifest_sha256", "owned_workers"}
    if not required <= set(receipt) or not isinstance(receipt["owned_workers"], dict) or not receipt["owned_workers"]:
        raise RuntimeError("handoff receipt is incomplete")
    old_pid = int(receipt["old_controller_pid"])
    if psutil.pid_exists(old_pid):
        raise RuntimeError("old controller PID is still live or has been reused")
    old_raw = lock.read_bytes()
    if hashlib.sha256(old_raw).hexdigest() != receipt["old_lock_sha256"] or old_raw.decode("ascii").strip() != str(old_pid):
        raise RuntimeError("old runner lock identity mismatch")
    manifest_raw = MANIFEST.read_bytes()
    if hashlib.sha256(manifest_raw).hexdigest() != receipt["manifest_sha256"]:
        raise RuntimeError("manifest changed after handoff receipt")
    manifest = json.loads(manifest_raw.decode("utf-8-sig"))
    adopted = {row["key"]: row for row in manifest["papers"] if row.get("adopt_running_worker")}
    if set(adopted) != set(receipt["owned_workers"]):
        raise RuntimeError("handoff worker set does not exactly match adopted manifest rows")
    for key, row in adopted.items():
        adoption, recorded = row["adopt_running_worker"], receipt["owned_workers"][key]
        if any(adoption.get(field) != recorded.get(field) for field in ("pid", "create_time", "source_sha256", "work_dir", "identity_receipt")):
            raise RuntimeError(f"handoff worker metadata mismatch: {key}")
        if not adopt_identity_matches(adoption, Path(row["source"]), paper_work_dir(row, adoption["work_dir"])):
            raise RuntimeError(f"handoff identity receipt mismatch: {key}")
    staged = lock.with_suffix(".handoff.staging")
    staged.write_text(str(os.getpid()), encoding="ascii")
    if lock.read_bytes() != old_raw:
        raise RuntimeError("old runner lock changed during handoff")
    os.replace(staged, lock)
    save(ROOT / "handoff-lock-receipts" / f"{old_pid}-to-{os.getpid()}.json",
         {"at": now(), "receipt": str(receipt_path), "old_lock_sha256": receipt["old_lock_sha256"],
          "old_lock_contents": old_raw.decode("ascii").strip(), "new_pid": os.getpid(), "state": "ownership_transferred"})


if __name__ == "__main__":
    main()
