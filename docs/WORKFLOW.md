# 论文批量阅读工作流

面对「要读的论文很多、英文阅读速度慢」的场景，关键不是单个工具，而是一条漏斗式流水线：大量进 → 快速筛 → 分级读 → 沉淀可复用笔记。本目录（`pipeline/`）是这条流水线的脚本快照，配合仓库根部的三栏阅读器使用。

## 漏斗总览

```
收集（每天/每周几十篇进库）
  ↓ ① LLM 评分：千分制批量打分 + 一句话理由（score_batch_papers.py）
留下「值得读」的候选
  ↓ ② 项目相关性重排：按在研方向加权（rank_papers_by_projects.py）
  ↓ ③ BabelDOC 整篇翻译镜像（run_translation_batch.py 等，保版式/公式/图表）
分级阅读：
  ↓ ④ 粗读：三栏阅读器里 摘要→图表→结论（约 10 分钟/篇）
  ↓ ⑤ 精读：三栏对照 + AI 会话提问（30–60 分钟/篇）
  ↓ ⑥ 沉淀：reader_save_thinking 回写论文卡片「## 阅读思考」
可检索、可复用的个人知识库（Obsidian）
```

## 各脚本职责

| 脚本 | 职责 |
| --- | --- |
| `score_batch_papers.py` | 全库 LLM 批量评分（千分制），与翻译 QA 分离；每篇带证据边界的一句话理由，产出可排序的分数 |
| `rank_papers_by_projects.py` | 在不改动既有分数的前提下叠加「项目相关性」维度，按当前研究方向重排队列 |
| `run_translation_batch.py` | 翻译主控：按范围（scope）批量跑 BabelDOC 单语镜像，门控审查，完成后回写阅读器索引（papers.json 的 `pdfZh` 字段） |
| `configure_translation_batch.py` | 应用实测的 CPU 并发设置与账号配额策略（从阅读器索引取条目） |
| `continue_translation_batch.py` | 在活动 PDF 试译通过后，续跑完整范围队列 |
| `bounded_babeldoc_worker.py` | 给每个翻译 worker 加 CPU 亲和/限额，不改 BabelDOC 安装包本体 |
| `start_scoped_translation_shim.py` | 用既有常驻桥 + 独立授权的账号 home 启动翻译会话 |

## 账号与配额策略（需自行配置）

快照中的账号均为占位符（`plus-account-a@example.com`、`account-id-a`、`fallback-account-id` 等）。实际使用时：

- 每个翻译会话绑定一个明确授权的 LLM 账号（auth home），脚本会校验登录身份与预期邮箱一致，不一致即拒绝启动；
- 主账号配额耗尽后才允许切 fallback，且必须是「已验证耗尽」而非预估；
- 账号配置文件放在仓库之外的私有目录，**不要把任何凭据、token、账号 ID 提交进仓库**。

## 运行纪律

- **镜像仅供中文参考**：BabelDOC 镜像在公式、表格、参考文献上可能出错，凡是要引用、复现、写进论文的内容，一律回左栏原文核对。
- **先筛后翻**：翻译是最贵的一步，评分/重排不过线的论文不进翻译队列。
- **失败分流**：翻译失败的条目进 `review_attention` 清单，人工确认是磁盘、页数超限还是源文件损坏，再决定重试或放弃。
- **增量更新**：新论文进库后重跑评分 → 重排 → 只翻增量，不重翻全库。
