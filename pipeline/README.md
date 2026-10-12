# pipeline/ — 翻译流水线脚本快照

这是实际运行中的翻译流水线的**快照拷贝**，用于展示完整工作流（详见 [../docs/WORKFLOW.md](../docs/WORKFLOW.md)）。

## 使用须知

- 脚本里的账号、邮箱、路径全部是占位符（`plus-account-a@example.com`、`account-id-a`、`C:\Users\<you>\...` 等），直接运行不会工作；
- 文件顶部的路径常量（库根目录、阅读器目录、输出目录、venv、auth home）需要按你的环境逐一修改；
- 依赖：Python 3.10+、[BabelDOC](https://github.com/funstory-ai/BabelDOC)、一个 OpenAI 兼容的 LLM 端点；
- 这些脚本与阅读器通过 `papers.json` 索引耦合：翻译完成后回写条目的 `pdfZh`（中文镜像路径），阅读器中栏随即显示。

## 文件清单

| 文件 | 一句话说明 |
| --- | --- |
| `run_translation_batch.py` | 翻译主控：范围批量 BabelDOC 镜像 + 门控审查 + 阅读器集成 |
| `configure_translation_batch.py` | 应用 CPU 并发设置与账号配额策略 |
| `continue_translation_batch.py` | 试译通过后续跑完整队列 |
| `bounded_babeldoc_worker.py` | worker 级 CPU 限额（不改动 BabelDOC 本体） |
| `start_scoped_translation_shim.py` | 用独立授权账号 home 启动翻译会话 |
| `score_batch_papers.py` | 全库千分制 LLM 评分（与翻译 QA 分离） |
| `rank_papers_by_projects.py` | 项目相关性加权重排 |
