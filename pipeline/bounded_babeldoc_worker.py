"""Apply per-worker CPU limits without changing installed BabelDOC packages."""
import concurrent.futures
import importlib.metadata
import json
import os
import re
import sys
from pathlib import Path

for name, value in {"OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "NUMEXPR_NUM_THREADS": "1"}.items():
    os.environ[name] = value

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path(os.environ.get("TRANSLATION_RUNTIME_ROOT", ROOT / "runtime"))
paper_key = os.environ.get("TRANSLATION_PAPER_KEY", "")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", paper_key):
    raise RuntimeError("TRANSLATION_PAPER_KEY is required and must be a safe paper key")
profile = RUNTIME / "worker-profiles" / paper_key
paper_cache = RUNTIME / "translation-caches" / paper_key
asset_cache = RUNTIME / "babeldoc-assets"
for directory in (RUNTIME / "tmp", RUNTIME / "cache", profile, paper_cache, asset_cache):
    directory.mkdir(parents=True, exist_ok=True)
for name, value in {
    "USERPROFILE": str(profile),
    "HOME": str(profile),
    "HOMEDRIVE": "E:",
    "HOMEPATH": str(profile)[2:],
    "TEMP": str(RUNTIME / "tmp"),
    "TMP": str(RUNTIME / "tmp"),
    "TMPDIR": str(RUNTIME / "tmp"),
    "XDG_CACHE_HOME": str(RUNTIME / "cache"),
    "BABELDOC_CACHE_DIR": str(paper_cache),
    "BABELDOC_CACHE_PATH": str(paper_cache),
}.items():
    os.environ[name] = value

# BabelDOC's installed cache module always chooses Path.home()/.cache/babeldoc.
# Give each paper a private SQLite/working cache before that module imports, while
# keeping hash-verified immutable model/font/CMap/tokenizer assets in one E: store.
import babeldoc.const as babeldoc_const


def cache_file_path(filename: str, sub_folder: str | None = None) -> Path:
    if sub_folder in {"models", "fonts", "cmap", "tiktoken"}:
        base = asset_cache
    else:
        base = paper_cache
    if sub_folder:
        base = base / sub_folder.strip("/")
    base.mkdir(parents=True, exist_ok=True)
    return base / filename


babeldoc_const.CACHE_FOLDER = paper_cache
babeldoc_const.TIKTOKEN_CACHE_FOLDER = asset_cache / "tiktoken"
babeldoc_const.TIKTOKEN_CACHE_FOLDER.mkdir(parents=True, exist_ok=True)
babeldoc_const.get_cache_file_path = cache_file_path
os.environ["TIKTOKEN_CACHE_DIR"] = str(babeldoc_const.TIKTOKEN_CACHE_FOLDER)

import cv2
import onnxruntime as ort

cv2.setNumThreads(1)
original_session = ort.InferenceSession


class BoundedSession(original_session):
    def __init__(self, path_or_bytes, sess_options=None, **kwargs):
        options = sess_options or ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.add_session_config_entry("session.inter_op.allow_spinning", "0")
        super().__init__(path_or_bytes, sess_options=options, **kwargs)


ort.InferenceSession = BoundedSession
import babeldoc.format.pdf.document_il.midend.layout_parser as layout_parser


def bounded_layout_pool(max_workers=None, *args, **kwargs):
    return concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers or 2, 2), *args, **kwargs)


layout_parser.ThreadPoolExecutor = bounded_layout_pool
print(json.dumps({"cpu_limits": {"ort_intra": 1, "ort_inter": 1, "ort_spinning": False,
                                "opencv": cv2.getNumThreads(), "layout_pool": 2,
                                "blas": 1}, "pid": os.getpid(), "paper_key": paper_key,
                  "translation_cache": str(paper_cache), "asset_cache": str(asset_cache)}), flush=True)
if "--cache-import-check" in sys.argv:
    import babeldoc.translator.cache  # initialize the per-paper SQLite cache
    print(json.dumps({"cache_import_check": "ok", "paper_key": paper_key,
                      "sqlite_path": str(paper_cache / "cache.v1.db"),
                      "asset_cache": str(asset_cache)}), flush=True)
    raise SystemExit(0)
if __name__ == "__main__":
    entrypoint = next(item for item in importlib.metadata.entry_points(group="console_scripts") if item.name == "babeldoc")
    sys.exit(entrypoint.load()())
