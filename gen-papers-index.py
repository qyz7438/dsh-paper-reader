# -*- coding: utf-8 -*-
"""gen-papers-index.py — 生成 papers.json（论文阅读工作流的论文索引）

数据源（全部只读，绝不写入 E:\\CLI\\llm-wiki 或 Zotero 库）：
  - 英文 PDF:   E:\\CLI\\llm-wiki\\pdfs\\会话新增\\论文-*.pdf
  - 中文镜像:   E:\\CLI\\llm-wiki\\pdfs\\会话新增-镜像\\论文-*_镜像.pdf
  - 论文卡片:   E:\\CLI\\llm-wiki\\_wiki\\references\\papers\\论文-*.md
  - 评分:       E:\\Zotero\\zotero.sqlite (callNumber 字段, rescore_zotero.py 写入)
  - 已读状态:   E:\\DSH1\\paper-reader\\reader-state.json (不存在则全部未读)

匹配规则：
  - slug = 文件名去掉 "论文-" 前缀与扩展名
  - 中英配对: 镜像文件名 = 原名 + "_镜像"
  - 卡片: slug 小写是卡片 stem 小写的子串（同 scripts/append_thinking.py）
  - 分数: 附件绝对路径 → 父条目 callNumber；兜底 卡片 arxiv id → Zotero 条目；
          再兜底 标题 slug 前 47 字符（同 rescore_zotero.py 的 stem47 规则）
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(r"E:\CLI\llm-wiki")
PDF_EN_DIR = ROOT / "pdfs" / "会话新增"
PDF_ZH_DIR = ROOT / "pdfs" / "会话新增-镜像"
CARDS_DIR = ROOT / "_wiki" / "references" / "papers"
ZOTERO_DB = Path(r"E:\Zotero\zotero.sqlite")
READER_STATE = Path(r"E:\DSH1\paper-reader\reader-state.json")
OUT = Path(r"E:\DSH1\paper-reader\papers.json")

ARXIV_RE = re.compile(r"(\d{4}\.\d{4,5})")
ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", re.I)
ARXIV_FM_RE = re.compile(r'^arxiv:\s*"?([^"\n]+)"?', re.M)

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def norm_path(p: str) -> str:
    return os.path.normcase(os.path.normpath(str(p)))


def slugify_title(title: str) -> str:
    """同 rescore_zotero.py 的 slug()：标题 → 小写连字符 slug。"""
    return re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")


def load_scores_from_zotero():
    """从 Zotero sqlite 只读提取评分映射。

    返回 (path2score, arxiv2score, slug47_2score) 三个映射；失败返回 None。
    """
    if not ZOTERO_DB.exists():
        print(f"[warn] Zotero 数据库不存在: {ZOTERO_DB}")
        return None
    try:
        con = sqlite3.connect(f"file:{ZOTERO_DB.as_posix()}?mode=ro", uri=True)
    except Exception as e:
        print(f"[warn] 无法只读打开 Zotero 数据库: {e}")
        return None
    cur = con.cursor()

    # 字段 ID（Zotero 标准 schema；现场核实 title=1, DOI=8, url=10, callNumber=17）
    fid = {}
    for name in ("title", "url", "callNumber"):
        cur.execute("SELECT fieldID FROM fields WHERE fieldName=?", (name,))
        row = cur.fetchone()
        fid[name] = row[0] if row else None
    if fid["callNumber"] is None:
        print("[warn] Zotero 库中没有 callNumber 字段")
        con.close()
        return None

    # itemID → callNumber 分数（'090.558' → 90.558）
    scores = {}
    cur.execute(
        """SELECT d.itemID, v.value FROM itemData d
           JOIN itemDataValues v ON d.valueID = v.valueID
           WHERE d.fieldID = ?""",
        (fid["callNumber"],),
    )
    for item_id, val in cur.fetchall():
        try:
            scores[item_id] = float(val)
        except (TypeError, ValueError):
            continue

    # itemID → title / url
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

    # 附件绝对路径 → parentItemID（linked-file 附件，path 为绝对路径）
    cur.execute(
        "SELECT path, parentItemID FROM itemAttachments WHERE path IS NOT NULL AND parentItemID IS NOT NULL"
    )
    path2parent = {}
    for path, parent in cur.fetchall():
        if path and parent:
            path2parent[norm_path(path)] = parent

    # parentItemID → arxiv（来自条目 url；兜底子 note 文本）
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

    path2score, arxiv2score, slug47_2score = {}, {}, {}
    for path, parent in path2parent.items():
        if parent in scores:
            path2score[path] = scores[parent]
    for arxiv, item_id in arxiv2item.items():
        if item_id in scores:
            arxiv2score.setdefault(arxiv, scores[item_id])
    for item_id, title in titles.items():
        if item_id in scores:
            slug47_2score.setdefault(slugify_title(title)[:47], scores[item_id])
    print(
        f"[zotero] 条目分数 {len(scores)}；附件路径映射 {len(path2score)}；"
        f"arxiv 映射 {len(arxiv2score)}；标题slug 映射 {len(slug47_2score)}"
    )
    return path2score, arxiv2score, slug47_2score


def load_cards():
    """卡片列表 + 卡片 stem 小写索引 + frontmatter arxiv。"""
    cards = []
    if not CARDS_DIR.is_dir():
        return cards
    for p in sorted(CARDS_DIR.glob("论文-*.md")):
        arxiv = None
        try:
            head = p.read_text(encoding="utf-8")[:2000]
            m = ARXIV_FM_RE.search(head)
            if m:
                arxiv = m.group(1).strip()
        except Exception:
            pass
        cards.append({"path": p, "stem_lower": p.stem.lower(), "arxiv": arxiv})
    return cards


def main():
    # ---- 已读状态 ----
    read_map = {}
    if READER_STATE.exists():
        try:
            raw = json.load(open(READER_STATE, encoding="utf-8"))
            read_map = {norm_path(k): bool(v.get("read")) for k, v in raw.items() if isinstance(v, dict)}
            print(f"[state] reader-state.json: {len(read_map)} 条")
        except Exception as e:
            print(f"[warn] reader-state.json 解析失败，按全部未读处理: {e}")
    else:
        print("[state] reader-state.json 不存在 → 全部未读")

    # ---- 分数 ----
    zot = load_scores_from_zotero()
    score_source = "zotero-sqlite" if zot else "unavailable"
    path2score, arxiv2score, slug47_2score = zot if zot else ({}, {}, {})

    # ---- 卡片 ----
    cards = load_cards()
    print(f"[cards] {len(cards)} 张卡片")

    # ---- 扫描英文 PDF ----
    pdfs = sorted(PDF_EN_DIR.glob("论文-*.pdf"))
    print(f"[pdfs] 英文 {len(pdfs)} 篇")

    entries = []
    match_stats = {"path": 0, "arxiv": 0, "slug47": 0, "none": 0}
    for pdf in pdfs:
        slug = pdf.name[: -len(".pdf")]
        if slug.startswith("论文-"):
            slug = slug[len("论文-"):]
        pdf_en = str(pdf)

        zh = PDF_ZH_DIR / f"论文-{slug}_镜像.pdf"
        pdf_zh = str(zh) if zh.exists() else None

        # 卡片：slug 小写子串匹配（同 append_thinking.py）
        hits = [c for c in cards if slug.lower() in c["stem_lower"]]
        card = hits[0] if hits else None
        card_path = str(card["path"]) if card else None
        arxiv = card["arxiv"] if card else None

        # 分数：附件路径 → arxiv → 标题 slug47
        score = None
        key = norm_path(pdf_en)
        if key in path2score:
            score = path2score[key]
            match_stats["path"] += 1
        elif arxiv and re.sub(r"v\d+$", "", arxiv) in arxiv2score:
            score = arxiv2score[re.sub(r"v\d+$", "", arxiv)]
            match_stats["arxiv"] += 1
        elif slugify_title(slug.replace("-", " "))[:47] in slug47_2score:
            score = slug47_2score[slugify_title(slug.replace("-", " "))[:47]]
            match_stats["slug47"] += 1
        else:
            match_stats["none"] += 1

        # 标题：优先卡片文件名，退化用 slug
        title = card["path"].stem[len("论文-"):] if card else slug

        entries.append(
            {
                "slug": slug,
                "title": title,
                "score": score,
                "read": read_map.get(norm_path(pdf_en), False),
                "pdfEn": pdf_en,
                "pdfZh": pdf_zh,
                "card": card_path,
                "arxiv": arxiv,
            }
        )

    entries.sort(key=lambda e: (e["score"] is None, -(e["score"] or 0)))

    out = {
        "scoreSource": score_source,
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "count": len(entries),
        "papers": entries,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    n_zh = sum(1 for e in entries if e["pdfZh"])
    n_card = sum(1 for e in entries if e["card"])
    n_score = sum(1 for e in entries if e["score"] is not None)
    n_read = sum(1 for e in entries if e["read"])
    print("\n===== 自检统计 =====")
    print(f"scoreSource : {score_source}")
    print(f"总条目数    : {len(entries)}")
    print(f"有镜像      : {n_zh}")
    print(f"有卡片      : {n_card}")
    print(f"有分数      : {n_score}  (路径匹配 {match_stats['path']} / arxiv {match_stats['arxiv']} / slug47 {match_stats['slug47']} / 无 {match_stats['none']})")
    print(f"已读        : {n_read}")
    print(f"输出        : {OUT}")

    print("\n===== 前 10 名 =====")
    for i, e in enumerate(entries[:10], 1):
        print(f"{i:2d}. [{e['score']!r:>9}] {e['title'][:70]}")

    print("\n===== SuperLocalMemory V3 抽样 =====")
    slm = [e for e in entries if "SuperLocalMemory-V3-Information-Geometric" in e["slug"]]
    print(json.dumps(slm, ensure_ascii=False, indent=2) if slm else "未找到！")
    return out


if __name__ == "__main__":
    main()
