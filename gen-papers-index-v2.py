# -*- coding: utf-8 -*-
"""gen-papers-index-v2.py — 全库论文索引 + 研究方向加权（生成 papers.v2.json）

在 v1（gen-papers-index.py）基础上的变更：
  变更1 覆盖全库:
    - 扫描 pdfs\\ 下全部子目录的 论文-*.pdf（排除 会话新增-镜像 / 会话新增-双语）
    - 根目录散落 *-arXiv-*.pdf 也收录（无法解析 slug 的跳过并计数）
    - 同名文件多目录出现时按 会话新增 > 会话交付 > 其他 取一个，dirs 记录全部出现目录
    - 镜像: 会话新增-镜像\\x_镜像.pdf ↔ 任意目录 x.pdf；会话新增-双语\\x_双语.pdf 兜底
    - 去重两级: ① arXiv 键（卡片/frontmatter/Zotero URL/标题slug 补齐后并组）
      ② 主 PDF 内容 SHA-256 相同并组（别名副本）；被并条目的镜像/已读/卡片并入保留条目
  变更2 加权（2026-09-18 领域版，替代旧五关键词簇）:
    score = baseScore(Zotero 原样) + boost,  boost ≤ 25
    boost = 命中领域中最高权重（多领域不叠加） + (survey/review/... +5)
    领域权重依据阅读行为标定（见 _working/paper_pipeline/领域分析-20260918.md）：
    mech/rs-geo/vg-3d +20，mem-agent +15，rl +12，continual +10，gen/vlm +8，
    llm-core +5，eval/mem-sys +0（mem-sys 为推理显存类，非阅读方向，不加分）
    封顶保证挖掘波(boost后 ≤ 59.999+25 = 84.999)不超过会话提到层(90/80)
  变更3 千分制（2026-10-09，用户拍板全量重排）:
    codex 宽泛打分(score_results.jsonl, 按卡片键) / B站 paper_scores.json(按 slug/arxiv)
    覆盖 score；镜像条目 score=-1 沉底；pinned score=1100-pinRank*0.1 置顶
    （pin 序 = PIN_ORDER ∪ 现 papers.json pinned 集）；无覆盖时回落变更2。

读：论文库、Zotero 库、reader-state.json。写：papers.v2.json，末尾自动晋升
      papers.json（先备份 .json.bak）并重建 reader-queue.json；绝不写 reader-state.json。
"""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(r"E:\CLI\llm-wiki")
PDFS = ROOT / "pdfs"
MIRROR_DIR = PDFS / "会话新增-镜像"
BILING_DIR = PDFS / "会话新增-双语"
EXCLUDE_DIRS = {"会话新增-镜像", "会话新增-双语"}
DIR_PRIORITY = {"会话新增": 0, "会话交付": 1}  # 其他=2，再按目录名保证确定性
CARDS_DIR = ROOT / "_wiki" / "references" / "papers"
ZOTERO_DB = Path(r"E:\Zotero\zotero.sqlite")
READER_STATE = Path(r"E:\DSH1\paper-reader\reader-state.json")
OUT = Path(r"E:\DSH1\paper-reader\papers.v2.json")

ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", re.I)
ARXIV_FM_RE = re.compile(r'^arxiv:\s*"?([^"\n]+)"?', re.M)
SCATTER_RE = re.compile(r"^(.+)-arXiv-(\d{4}\.\d{4,5})\.pdf$", re.I)

# ---------- 变更2：领域赋权（title/slug 小写匹配；取命中领域最高权重，不叠加） ----------
# 权重标定依据: _working/paper_pipeline/领域分析-20260918.md（阅读行为 + 项目会话）
DOMAIN_BOOST = [
    ("mech", 20, r"circuit|interpretab|probing|sparse autoencoder|\bsae\b|logit lens|grokking|mechanistic|intrinsic dimension|neural collapse|weight[ -]?space|superposition|representation|hidden (state|representation)|activation|emergen|feature (geometry|manifold)|causal abstraction|concept (bottleneck|erasur)|linear probe|in-context learning|loss[ -]landscape|flatness|training (dynamic|trajector)|optimization dynamic"),
    ("rs-geo", 20, r"remote sensing|satellite|aerial|orthophoto|geospatial|earth observation|land cover|change detection|change caption|change interpret|\buav\b|hyperspectral|\bsar\b|DOTA"),
    ("vg-3d", 20, r"referring expression|visual grounding|3d visual|point cloud|embodied(?! agent)|visual navigation|object detection|segment anything|open-vocabulary"),
    ("mem-agent", 15, r"(agent|agents|assistant).{0,50}memo|memo\w*.{0,50}agent|episodic memory|long-term memory|memory (os|operating system|architecture|module|bank|lifecycle|distillation)|memory-augmented|self-evolv|experience (replay|distillation)|conversational memory|personal memory|grounded memory|memgpt|mem0\b|localmemory|memo\w*\s+v?\d"),
    ("rl", 12, r"reinforcement|rlhf|rlvr|grpo|\bdpo\b|\bppo\b|reward (model|shap|hack)|preference optim|post-training|policy (optimization|gradient)|q-learning|offline rl|imitation learning|world model|credit assignment|gflownet"),
    ("continual", 10, r"continual|lifelong learning|catastrophic forgetting|incremental learning|never-ending|task-incremental"),
    ("gen", 8, r"diffusion|flow matching|text-to-image|image generation|video generation|\bgan\b|visual generation|image synthesis"),
    ("vlm", 8, r"vision-language|vision language|\bvlm\b|mllm|multimodal|multi-modal|visual instruction|image understanding|video understanding|visual question|image caption|thinking with images|image-text|cross-modal retrieval"),
    ("llm-core", 5, r"transformer (architecture|variant)|attention mechanism|mamba|state space model|mixture-of-experts|\bmoe\b|pretrain|scaling law|tokeniz|positional|rotary|long[ -]context|context window|sparse attention"),
    # 权重 0: 记录命中但不加分（推理显存/KV cache 类非阅读方向；eval 由 survey 规则覆盖）
    ("mem-sys", 0, r"kv.?cache|key-value cache|speculative decoding|serving|throughput|latency|prefill|disaggregat|quantiz|pruning|memory (footprint|efficien|consumption|saving|reduction)|memory-efficient|on-device|edge deploy|offload"),
    ("eval", 0, r"benchmark|evaluation|survey|review|tutorial|roadmap"),
]
DOMAIN_BOOST_RE = [(k, w, re.compile(rx, re.I)) for k, w, rx in DOMAIN_BOOST]
SURVEY_RE = re.compile(r"survey|review|tutorial|benchmark|roadmap|foundation model", re.I)
SURVEY_BONUS = 5
BOOST_CAP = 25

# ---------- 千分制分源（2026-10-09 起优先于 baseScore+boost） ----------
SCORE_RESULTS = Path(r"E:\CLI\llm-wiki\_working\paper_pipeline\score_results_v2.jsonl")
PAPER_SCORES = Path(r"E:\CLI\llm-wiki\_working\bilibili-296-reading-flow\translation-flow\paper_scores.json")


def load_codex_scores():
    """codex_broad_score.py 结果(按卡片键) + B站 paper_scores(按 slug/arxiv)。"""
    by_card = {}
    if SCORE_RESULTS.exists():
        for line in open(SCORE_RESULTS, encoding="utf-8"):
            try:
                r = json.loads(line)
                by_card[r["card"]] = r
            except Exception:
                pass
    by_slug, by_arxiv = {}, {}
    if PAPER_SCORES.exists():
        try:
            ps = json.load(open(PAPER_SCORES, encoding="utf-8"))
            for it in ps.get("papers", []):
                if it.get("reader_slug"):
                    by_slug[it["reader_slug"]] = it
                if it.get("arxiv"):
                    by_arxiv[it["arxiv"]] = it
        except Exception:
            pass
    return by_card, by_slug, by_arxiv

# ---------- 置顶：项目核心论文排队列最前 ----------
# 当前 = 项目核心论文 6 文件夹（05..10）库内选文。
# 焦李成老师汇报包 28 篇已于 2026-10-12 解除置顶（用户要求恢复正常 codex 分，汇报已交付）。
PIN_ORDER = [
    # ════ 项目核心论文（05-10 方向） ════
    # 05_视觉工具推理
    "OpenThinkIMG-Learning-to-Think-with-Images-via-Visual-Tool-Reinforcement",
    "Thinking-with-Images-for-Multimodal-Reasoning-Foundations-Methods-and-Future",
    "TIR-Bench-A-Comprehensive-Benchmark-for-Agentic-Thinking-with-Images-Reasoning",
    "Reinforcing-VLMs-to-Use-Tools-for-Detailed-Visual-Reasoning-Under-Resource",
    "Visual-Reasoning-Agent-Robust-Vision-Systems-in-Remote-Sensing-via-Inference",
    "Superposition-Emergence-Continuous-Thought",
    # 06_信息流理解
    "Improving-Causal-Interventions-in-Amnesic-Probing-with-Mean-Projection-or-LEACE",
    "Information-Theoretic-Probing-for-Linguistic-Structure",
    "Pareto-Probing-Trading-Off-Accuracy-for-Complexity",
    "Bilinear-MLPs-enable-weight-based-mechanistic-interpretability",
    # 07_表征几何
    "Flatness-is-Necessary-Neural-Collapse-is-Not-Rethinking-Generalization-via",
    "Neural-Collapse-with-Unconstrained-Features",
    "Emergent-Riemannian-geometry-over-learning-discrete-computations-on-continuous",
    "Geometry-as-a-Missing-Axis-of-Representation-Quality-The-Variational-Geometric",
    "Training-Instabilities-Induce-Flatness-Bias-in-Gradient-Descent",
    # 08_结构涌现
    "Grokking-Generalization-Beyond-Overfitting-on-Small-Algorithmic-Datasets",
    "Egalitarian-Gradient-Descent-A-Simple-Approach-to-Accelerated-Grokking",
    "Explaining-Grokking-and-Information-Bottleneck-through-Neural-Collapse-Emergence",
    "Is-Grokking-Worthwhile-Functional-Analysis-and-Transferability-of",
    "Grokking-as-the-Transition-from-Lazy-to-Rich-Training-Dynamics",
    "Progress-Measures-for-Grokking",
    # 09_遥感反事实定位（库内选文）
    "Deconfounded-Visual-Grounding",
    "Language-Guided-Hybrid-Representation-Learning-for-Visual-Grounding-on-Remote",
    "Mono3DVG-3D-Visual-Grounding-in-Monocular-Images",
    "Referring-Expression-Comprehension-A-Survey-of-Methods-and-Datasets",
    "RRSIS-Referring-Remote-Sensing-Image-Segmentation",
    # 10_训练轨迹流形
    "Classifying-the-classifier-dissecting-the-weight-space-of-neural-networks",
    "A-Survey-of-Weight-Space-Learning-Understanding-Representation-and-Generation",
    "Editing-Models-with-Task-Arithmetic",
    "Truth-as-a-Trajectory-What-Internal-Representations-Reveal-About-Large-Language",
]

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def norm_path(p: str) -> str:
    return os.path.normcase(os.path.normpath(str(p)))


def slugify_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")


def load_scores_from_zotero():
    if not ZOTERO_DB.exists():
        print(f"[warn] Zotero 数据库不存在: {ZOTERO_DB}")
        return None
    try:
        con = sqlite3.connect(f"file:{ZOTERO_DB.as_posix()}?mode=ro", uri=True)
    except Exception as e:
        print(f"[warn] 无法只读打开 Zotero 数据库: {e}")
        return None
    cur = con.cursor()
    fid = {}
    for name in ("title", "url", "callNumber"):
        cur.execute("SELECT fieldID FROM fields WHERE fieldName=?", (name,))
        row = cur.fetchone()
        fid[name] = row[0] if row else None
    if fid["callNumber"] is None:
        con.close()
        return None

    scores = {}
    cur.execute(
        """SELECT d.itemID, v.value FROM itemData d
           JOIN itemDataValues v ON d.valueID = v.valueID WHERE d.fieldID = ?""",
        (fid["callNumber"],),
    )
    for item_id, val in cur.fetchall():
        try:
            scores[item_id] = float(val)
        except (TypeError, ValueError):
            continue

    titles, urls = {}, {}
    if fid["title"] is not None:
        cur.execute(
            """SELECT d.itemID, v.value FROM itemData d
               JOIN itemDataValues v ON d.valueID = v.valueID WHERE d.fieldID = ?""",
            (fid["title"],),
        )
        titles = dict(cur.fetchall())
    if fid["url"] is not None:
        cur.execute(
            """SELECT d.itemID, v.value FROM itemData d
               JOIN itemDataValues v ON d.valueID = v.valueID WHERE d.fieldID = ?""",
            (fid["url"],),
        )
        urls = dict(cur.fetchall())

    cur.execute(
        "SELECT path, parentItemID FROM itemAttachments WHERE path IS NOT NULL AND parentItemID IS NOT NULL"
    )
    path2parent = {norm_path(p): par for p, par in cur.fetchall() if p and par}

    arxiv2item = {}
    for item_id, url in urls.items():
        m = ARXIV_URL_RE.search(url or "")
        if m:
            arxiv2item.setdefault(m.group(1), item_id)
    cur.execute("SELECT parentItemID, note FROM itemNotes WHERE parentItemID IS NOT NULL")
    for parent, note in cur.fetchall():
        m = re.search(r"arXiv[:\s]*(\d{4}\.\d{4,5})", note or "", re.I)
        if m and parent not in arxiv2item.values():
            arxiv2item.setdefault(m.group(1), parent)
    con.close()

    path2score = {p: scores[par] for p, par in path2parent.items() if par in scores}
    arxiv2score, slug47_2score = {}, {}
    for ax, iid in arxiv2item.items():
        if iid in scores:
            arxiv2score.setdefault(ax, scores[iid])
    for iid, t in titles.items():
        if iid in scores:
            slug47_2score.setdefault(slugify_title(t)[:47], scores[iid])
    # 标题slug → arxiv（给缺 arxiv 的条目补键，供 arXiv 去重组用）
    item2arxiv = {}
    for ax, iid in arxiv2item.items():
        item2arxiv.setdefault(iid, ax)
    slug47_2arxiv = {}
    for iid, t in titles.items():
        if iid in item2arxiv:
            slug47_2arxiv.setdefault(slugify_title(t)[:47], item2arxiv[iid])
    print(
        f"[zotero] 条目分数 {len(scores)}；附件路径映射 {len(path2score)}；"
        f"arxiv 映射 {len(arxiv2score)}；标题slug 映射 {len(slug47_2score)}；slug→arxiv {len(slug47_2arxiv)}"
    )
    return path2score, arxiv2score, slug47_2score, slug47_2arxiv


def load_cards():
    cards = []
    if not CARDS_DIR.is_dir():
        return cards
    for p in sorted(CARDS_DIR.glob("论文-*.md")):
        arxiv = None
        try:
            m = ARXIV_FM_RE.search(p.read_text(encoding="utf-8")[:2000])
            if m:
                arxiv = m.group(1).strip()
        except Exception:
            pass
        cards.append({"path": p, "stem_lower": p.stem.lower(), "arxiv": arxiv})
    return cards


def compute_boost(slug: str):
    """返回 (boost, reasons)。命中领域取最高权重（不叠加）；survey 类再 +5；总封顶 25。
    权重 0 的领域只记录命中、不加分。"""
    hay = slug.lower() + " " + slug.lower().replace("-", " ")
    hits = [(name, w) for name, w, rx in DOMAIN_BOOST_RE if rx.search(hay)]
    boost = max((w for _n, w in hits), default=0)
    reasons = [f"{name}+{w}" if w else f"{name}+0" for name, w in hits]
    if SURVEY_RE.search(hay):
        boost += SURVEY_BONUS
        reasons.append(f"survey+{SURVEY_BONUS}")
    return min(boost, BOOST_CAP), reasons


def main():
    # ---- 已读状态（只读；键为 pdfEn 绝对路径） ----
    # 实际运行态格式（阅读器前端写入）：顶层键 = pdf 绝对路径，值为 true；
    # 另有一个 "current" 对象记录当前阅读位置。兼容 v1 约定的 {read:true} 形式。
    read_map = {}
    if READER_STATE.exists():
        try:
            raw = json.load(open(READER_STATE, encoding="utf-8"))
            for k, v in raw.items():
                if k == "current" or not isinstance(k, str) or not k.lower().endswith(".pdf"):
                    continue
                read_map[norm_path(k)] = bool(v.get("read")) if isinstance(v, dict) else bool(v)
            print(f"[state] reader-state.json: {len(read_map)} 条（已读 {sum(read_map.values())}）")
        except Exception as e:
            print(f"[warn] reader-state.json 解析失败，按全部未读处理: {e}")
    else:
        print("[state] reader-state.json 不存在 → 全部未读")

    # ---- 分数 ----
    zot = load_scores_from_zotero()
    score_source = "zotero-sqlite" if zot else "unavailable"
    path2score, arxiv2score, slug47_2score, slug47_2arxiv = zot if zot else ({}, {}, {}, {})

    # ---- 卡片 ----
    cards = load_cards()
    print(f"[cards] {len(cards)} 张卡片")

    # ---- 变更1：扫描全库 ----
    # filename -> [dir, ...]
    name2dirs = {}
    for d in sorted(os.listdir(PDFS)):
        full = PDFS / d
        if not full.is_dir() or d in EXCLUDE_DIRS:
            continue
        for f in os.listdir(full):
            if f.startswith("论文-") and f.lower().endswith(".pdf"):
                name2dirs.setdefault(f, []).append(d)

    def dir_key(d):
        return (DIR_PRIORITY.get(d, 2), d)

    # 根目录散落 *-arXiv-*.pdf
    scattered, scatter_skipped = [], 0
    for f in sorted(os.listdir(PDFS)):
        fp = PDFS / f
        if not fp.is_file() or not f.lower().endswith(".pdf"):
            continue
        m = SCATTER_RE.match(f)
        if m:
            scattered.append({"file": f, "slug": m.group(1), "arxiv": m.group(2)})
        else:
            scatter_skipped += 1
            print(f"[skip] 根目录散落 PDF 无法解析 slug: {f}")
    print(f"[scan] 去重后论文 {len(name2dirs)}（重名 {sum(1 for v in name2dirs.values() if len(v) > 1)} 组）；根目录散落 {len(scattered)}，跳过 {scatter_skipped}")

    # 镜像 / 双语索引（stem -> path）
    mirror_map, biling_map = {}, {}
    if MIRROR_DIR.is_dir():
        for f in os.listdir(MIRROR_DIR):
            if f.lower().endswith("_镜像.pdf"):
                mirror_map[f[: -len("_镜像.pdf")]] = str(MIRROR_DIR / f)
    if BILING_DIR.is_dir():
        for f in os.listdir(BILING_DIR):
            if f.lower().endswith("_双语.pdf"):
                biling_map[f[: -len("_双语.pdf")]] = str(BILING_DIR / f)

    # ---- 组装条目 ----
    entries = []
    match_stats = {"path": 0, "arxiv": 0, "slug47": 0, "none": 0}
    used_mirror_stems, used_biling_stems = set(), set()

    def build_entry(stem, slug, dirs, paths, arxiv_hint=None):
        """stem=论文-x 文件名主体；paths=所有出现位置（首选路径在 dirs[0]）。"""
        pdf_en = str(PDFS / dirs[0] / f"{stem}.pdf") if dirs[0] != "." else str(PDFS / f"{stem}.pdf")

        # 镜像优先，双语兜底
        pdf_zh = None
        if stem in mirror_map:
            pdf_zh = mirror_map[stem]
            used_mirror_stems.add(stem)
        elif stem in biling_map:
            pdf_zh = biling_map[stem]
            used_biling_stems.add(stem)

        # 卡片匹配先精确（论文-<slug>），避免短 slug（如 CLIP）子串误配到 BEV-CLIP 等长名卡片
        exact = [c for c in cards if c["stem_lower"] == "论文-" + slug.lower()]
        hits = exact or [c for c in cards if slug.lower() in c["stem_lower"]]
        card = hits[0] if hits else None
        arxiv = (card["arxiv"] if card else None) or arxiv_hint
        if not arxiv:
            # 别名条目缺 arxiv: 用 Zotero 标题 slug 补键，让 arXiv 去重能并组
            k47a = slugify_title((card["path"].stem[len("论文-"):] if card else slug).replace("-", " "))[:47]
            k47b = slugify_title(slug.replace("-", " "))[:47]
            arxiv = slug47_2arxiv.get(k47a) or slug47_2arxiv.get(k47b)

        base = None
        for pth in paths:
            if norm_path(pth) in path2score:
                base = path2score[norm_path(pth)]
                match_stats["path"] += 1
                break
        if base is None and arxiv and re.sub(r"v\d+$", "", arxiv) in arxiv2score:
            base = arxiv2score[re.sub(r"v\d+$", "", arxiv)]
            match_stats["arxiv"] += 1
        if base is None:
            k47 = slugify_title(slug.replace("-", " "))[:47]
            if k47 in slug47_2score:
                base = slug47_2score[k47]
                match_stats["slug47"] += 1
        if base is None:
            match_stats["none"] += 1

        boost, reasons = compute_boost(slug)
        score = round(base + boost, 3) if base is not None else None
        title = card["path"].stem[len("论文-"):] if card else slug
        return {
            "slug": slug,
            "title": title,
            "score": score,
            "baseScore": base,
            "boost": boost,
            "boostReason": reasons,
            "read": read_map.get(norm_path(pdf_en), False),
            "pdfEn": pdf_en,
            "pdfZh": pdf_zh,
            "card": str(card["path"]) if card else None,
            "arxiv": arxiv,
            "dirs": list(dirs),
        }

    for fname, dirs in name2dirs.items():
        dirs_sorted = sorted(dirs, key=dir_key)
        stem = fname[: -len(".pdf")]
        slug = stem[len("论文-"):] if stem.startswith("论文-") else stem
        paths = [str(PDFS / d / fname) for d in dirs_sorted]
        entries.append(build_entry(stem, slug, dirs_sorted, paths))

    for s in scattered:
        stem = s["file"][: -len(".pdf")]
        e = build_entry(stem, s["slug"], ["."], [str(PDFS / s["file"])], arxiv_hint=s["arxiv"])
        e["dirs"] = ["(根目录)"]
        entries.append(e)

    orphan_mirrors = sorted(set(mirror_map) - used_mirror_stems)
    orphan_biling = sorted(set(biling_map) - used_biling_stems)

    # ---- arXiv 去重: 同一论文多个PDF副本只保留一条(高分优先, 同级按目录优先级) ----
    def _arxiv_key(e):
        a = e.get("arxiv")
        return re.sub(r"v\d+$", "", a) if a else None

    def _merge_dups(idxs):
        """idxs 已按保留优先级排序; 被并条目的镜像/已读/卡片/arxiv/目录补到保留条目。"""
        keeper = entries[idxs[0]]
        for j in idxs[1:]:
            e = entries[j]
            if not keeper.get("pdfZh") and e.get("pdfZh"):
                keeper["pdfZh"] = e["pdfZh"]
            if e.get("read"):
                keeper["read"] = True
            if not keeper.get("card") and e.get("card"):
                keeper["card"] = e["card"]
            if not keeper.get("arxiv") and e.get("arxiv"):
                keeper["arxiv"] = e["arxiv"]
            for d in e["dirs"]:
                if d not in keeper["dirs"]:
                    keeper["dirs"].append(d)

    _groups = {}
    for i, e in enumerate(entries):
        k = _arxiv_key(e)
        if k:
            _groups.setdefault(k, []).append(i)
    drop_idx = set()
    for k, idxs in _groups.items():
        if len(idxs) < 2:
            continue
        idxs.sort(key=lambda i: (
            -(entries[i]["score"] or 0),
            min(DIR_PRIORITY.get(d, 2) if d != "(根目录)" else 3 for d in entries[i]["dirs"]),
        ))
        _merge_dups(idxs)
        drop_idx.update(idxs[1:])
    if drop_idx:
        entries = [e for i, e in enumerate(entries) if i not in drop_idx]
        print(f"[dedup] arXiv 重复组 {sum(1 for v in _groups.values() if len(v)>1)}, 移除条目 {len(drop_idx)}")

    # ---- 内容哈希去重: 主 PDF 字节完全相同(别名副本)只保留一条 ----
    def _sort_key(i):
        return (
            -(entries[i]["score"] or 0),
            min(DIR_PRIORITY.get(d, 2) if d != "(根目录)" else 3 for d in entries[i]["dirs"]),
        )

    size_groups = {}
    for i, e in enumerate(entries):
        try:
            size_groups.setdefault(os.path.getsize(e["pdfEn"]), []).append(i)
        except OSError:
            continue
    hash_groups = {}
    for _sz, idxs in size_groups.items():
        if len(idxs) < 2:
            continue
        for i in idxs:
            try:
                with open(entries[i]["pdfEn"], "rb") as fh:
                    h = hashlib.sha256(fh.read()).hexdigest()
            except OSError:
                continue
            hash_groups.setdefault(h, []).append(i)
    drop2 = set()
    for h, idxs in hash_groups.items():
        if len(idxs) < 2:
            continue
        idxs.sort(key=_sort_key)
        _merge_dups(idxs)
        drop2.update(idxs[1:])
    if drop2:
        entries = [e for i, e in enumerate(entries) if i not in drop2]
        print(f"[dedup2] 内容相同组 {sum(1 for v in hash_groups.values() if len(v)>1)}, 移除条目 {len(drop2)}")

    # ---- 千分制覆盖（2026-10-09）: codex 宽泛打分 / B站 paper_scores 优先；镜像沉底 ----
    codex_by_card, ps_by_slug, ps_by_arxiv = load_codex_scores()
    n_codex = n_ps = n_mirror_sink = 0
    for e in entries:
        slug = e.get("slug") or ""
        dirs = e.get("dirs") or []
        if slug.endswith("_镜像") or any("镜像" in d for d in dirs):
            e["score"] = -1
            n_mirror_sink += 1
            continue
        card_name = Path(str(e["card"])).name if e.get("card") else ""
        if not card_name:
            card_name = "论文-" + slug + ".md"
        r = codex_by_card.get(card_name)
        if r is not None:
            e["score"] = float(r["total"])
            e["scoreWhy"] = r.get("why", "")
            n_codex += 1
            continue
        it = ps_by_slug.get(slug) or (ps_by_arxiv.get(e["arxiv"]) if e.get("arxiv") else None)
        if it is not None:
            st = it.get("score_total")
            if st is None:
                lo = it.get("score_lower_bound") or 0
                hi = it.get("score_upper_bound") or lo
                st = round((lo + hi) / 2)
            e["score"] = float(st)
            n_ps += 1
    print(f"[codex1000] 千分制 codex={n_codex} B站={n_ps} 镜像沉底={n_mirror_sink}")

    # ---- 置顶排序: pinned 按 pin 序排最前，其余按分数（阅读器按 score 降序渲染） ----
    # dsh-reader/client.js 按 score 降序重排（缺失值垫底），故置顶条目必须把
    # score 覆写到千分制上限(1000)之上：score = 1100 - pinRank*0.1（原分数保留在 baseScore）。
    # pin 序 = PIN_ORDER ∪ 现 papers.json 的 pinned 集（防止 PIN_ORDER 滞后丢钉）。
    pin_list = list(PIN_ORDER)
    live_idx = OUT.with_name("papers.json")
    if live_idx.exists():
        try:
            live_d = json.load(open(live_idx, encoding="utf-8"))
            live_pins = sorted([p for p in live_d.get("papers", []) if p.get("pinned")],
                               key=lambda p: p.get("pinRank", 0))
            for p in live_pins:
                if p.get("slug") and p["slug"] not in pin_list:
                    pin_list.append(p["slug"])
        except Exception:
            pass
    pin_rank = {s: i for i, s in enumerate(pin_list)}
    for e in entries:
        if e["slug"] in pin_rank:
            e["pinned"] = True
            e["pinRank"] = pin_rank[e["slug"]]
            e["score"] = round(1100.0 - 0.1 * e["pinRank"], 3)
        else:
            e["pinned"] = False
    entries.sort(key=lambda e: (not e["pinned"], pin_rank.get(e["slug"], 0),
                                e["score"] is None, -(e["score"] or 0)))
    found_pins = {e["slug"] for e in entries if e["pinned"]}
    lost_pins = [s for s in pin_list if s not in found_pins]
    print(f"[pin] 置顶 {len(found_pins)}/{len(pin_list)}；未命中 {len(lost_pins)} {lost_pins if lost_pins else ''}")

    out = {
        "scoreSource": "codex-broad-score-1000",
        "scoring": {
            "formula": ("千分制优先: 相关500 (=100*max(r1..r4, 焦李成署名兜底5)) + 质量300 (=30*(nov+rig)) "
                        "+ 影响200 (venue 80/40 + min(80,20*log10(1+cit)) + recency 40..10); "
                        "B站条目取 translation-flow/paper_scores.json (score_total 缺失时用区间中值); "
                        "镜像条目 score=-1 沉底; pinned score=1100-pinRank*0.1 置顶。"
                        "无千分制覆盖时回落 score = baseScore + boost (boost ≤ 25)"),
            "rubric": "original-session-1000-v1 (codex_broad_score.py, gpt-6-luna 全量重打分 v2, 2026-10-09)",
            "pinnedDisplay": "1100 - pinRank*0.1",
            "legacy": "baseScore: Zotero callNumber 原样（rescore_zotero.py 分层）; boost: 命中领域最高权重（不叠加）+survey+5, 封顶 25; 保留仅供回溯",
            "domainBoost": {k: w for k, w, _rx in DOMAIN_BOOST},
            "boostRule": "取命中领域最高权重；mem-sys/eval 权重 0 只记录不加分",
            "surveyBonus": SURVEY_BONUS,
            "boostCap": BOOST_CAP,
            "calibration": "领域权重依据 _working/paper_pipeline/领域分析-20260918.md（阅读行为+六项目会话）",
            "surveyPattern": SURVEY_RE.pattern,
        },
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "count": len(entries),
        "papers": entries,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- 同步到阅读器数据源（桥 reader-bridge-standalone.mjs 读 papers.json，60s 缓存；
    #      2026-09-30 前 v2 只写 papers.v2.json 导致阅读器停在 09-18 快照，现每次生成自动晋升）----
    promo = OUT.read_text(encoding="utf-8")
    p1 = OUT.with_name("papers.json")
    if p1.exists():
        shutil.copy2(p1, p1.with_suffix(".json.bak"))
    p1.write_text(promo, encoding="utf-8")
    queue_file = OUT.with_name("reader-queue.json")
    unread_order = [e["slug"] for e in entries if not e.get("read")]
    queue_file.write_text(json.dumps({"pointer": 0, "order": unread_order}, ensure_ascii=False), encoding="utf-8")
    print(f"[promote] papers.json + reader-queue.json 已同步（未读 {len(unread_order)}）")

    # ---- 自检统计 ----
    n_zh = sum(1 for e in entries if e["pdfZh"])
    n_card = sum(1 for e in entries if e["card"])
    n_score = sum(1 for e in entries if e["baseScore"] is not None)
    n_read = sum(1 for e in entries if e["read"])
    boost_dist = {0: 0, 5: 0, 20: 0, 25: 0}
    for e in entries:
        boost_dist[e["boost"]] = boost_dist.get(e["boost"], 0) + 1
    sess_new_mirror = sum(
        1 for e in entries if e["dirs"][0] == "会话新增" and e["pdfZh"] and "_镜像" in e["pdfZh"]
    )
    print("\n===== 自检统计 =====")
    print(f"scoreSource : {score_source}")
    print(f"总条目数    : {len(entries)}（含根目录散落 {len(scattered)}）")
    print(f"有镜像/双语 : {n_zh}（镜像配对 {len(used_mirror_stems)}，双语兜底 {len(used_biling_stems)}）")
    print(f"孤儿镜像    : {len(orphan_mirrors)} {[m[:40] for m in orphan_mirrors]}")
    print(f"孤儿双语    : {len(orphan_biling)}")
    print(f"有卡片      : {n_card}")
    print(f"分数覆盖    : {n_score}/{len(entries)}（路径 {match_stats['path']} / arxiv {match_stats['arxiv']} / slug47 {match_stats['slug47']} / 无分 {match_stats['none']}）")
    print(f"boost 分布  : {dict(sorted(boost_dist.items(), key=lambda x: -x[1]))}")
    print(f"已读        : {n_read}")
    print(f"会话新增镜像: {sess_new_mirror}")
    print(f"输出        : {OUT}")

    print("\n===== Top 40 =====")
    for i, e in enumerate(entries[:40], 1):
        print(f"{i:2d}. [{e['score']!r:>9}] +{e['boost']:<2d} {e['title'][:66]}")

    print("\n===== 抽查断言 =====")
    slm = [e for e in entries if "SuperLocalMemory-V3-Information-Geometric" in e["slug"]]
    if slm:
        s = slm[0]
        ok = s["boost"] > 0 and any(r.startswith("mem-agent") for r in s["boostReason"])
        print(f"SuperLocalMemory-V3: boost={s['boost']} reasons={s['boostReason']} score={s['score']} → {'PASS' if ok else 'FAIL'}")
    else:
        print("SuperLocalMemory-V3: 未找到 → FAIL")
    kv = [e for e in entries if "KV" in e["slug"] or "kv" in e["slug"].lower()]
    for e in kv[:3]:
        ok = e["boost"] <= SURVEY_BONUS
        print(f"{e['slug'][:52]}: boost={e['boost']} reasons={e['boostReason']} → {'PASS(mem-sys不加分)' if ok else 'FAIL'}")
    conv2 = [e for e in entries if e["slug"].startswith("A-ConvNet-for-the-2020s")]
    ok = bool(conv2) and any(c["pdfZh"] for c in conv2)
    print(f"A-ConvNet 组: {len(conv2)} 条, 有镜像={'是' if ok else '否'} → {'PASS' if ok else 'FAIL'}")
    for c in conv2:
        print(f"  {c['slug'][:50]} dirs={c['dirs']} pdfZh={'有' if c['pdfZh'] else '无'} read={c['read']}")


if __name__ == "__main__":
    main()
