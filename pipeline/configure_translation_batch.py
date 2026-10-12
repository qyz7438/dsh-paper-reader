"""Apply the measured CPU settings and explicitly authorized quota policy."""
from run_translation_batch import ROOT, READER, OUTPUT, MANIFEST, PLUS_ACCOUNTS, load, save, now
from pathlib import Path


def main():
    data = load(MANIFEST)
    lookup = {r["slug"]: r for r in load(READER / "papers.json")["papers"]}
    policy = data["policy"]
    policy.pop("forbidden_plan", None)
    policy.pop("allowed_email", None)
    policy.update(workers=4, quota_threshold=100, allowed_plus=PLUS_ACCOUNTS,
                  fallback="fallback-account@example.com only after verified 100% quota use of every allowed Plus account",
                  cpu_limits={"ort_intra": 2, "ort_inter": 1, "spinning": False, "opencv": 1, "blas": 1,
                              "layout_pool": 2, "priority": "below_normal"})
    for row in data["papers"]:
        if row["status"] not in {"translation_failed", "review_attention"}:
            continue
        row.setdefault("attempt_history", []).append({"at": now(), "status": row["status"],
                                                       "error": row.get("error"), "review": row.get("review"), "output": row.get("output")})
        if row["status"] == "review_attention":
            row["prior_reader_mirror"] = lookup[row["slug"]].get("pdfZh")
            row["output"] = str(OUTPUT / (Path(row["source"]).stem + "_镜像.pdf"))
        row.update(status="pending")
        for key in ("error", "review", "failed_at", "worker_pid"):
            row.pop(key, None)
    data.update(status="ready_after_cpu_optimization", policy_updated_at=now())
    save(MANIFEST, data)


if __name__ == "__main__":
    main()
