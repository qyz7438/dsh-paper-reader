# dsh-paper-reader

> **English**: A three-pane paper-reading workspace for the DSH desktop agent: English original PDF (left) | BabelDOC Chinese mirror PDF (middle) | native AI conversation (right). Ships as a DSH sidebar plugin plus an authenticated loopback reader bridge, with a batch translation pipeline (scoring → triage → BabelDOC mirror → mirror-aware reading) included under `pipeline/`. Designed for reading many papers in Chinese while keeping the original one glance away.

为「英文水平有限但要大量读论文」的场景设计的三栏阅读工作区：

```
┌──────────────────┬──────────────────┬──────────────────┐
│  英文原文 PDF     │  中文镜像 PDF     │   DSH AI 会话     │
│  （左栏）         │  （BabelDOC）     │   （右栏，原生）  │
└──────────────────┴──────────────────┴──────────────────┘
```

- 左栏：论文英文原文（PDF.js 渲染）
- 中栏：同版式中文镜像（BabelDOC 翻译产物，公式图表原位保留），与左栏**页码同步 / 滚轮翻页联动**
- 右栏：DSH 原生 AI 会话，选中 PDF 文字可一键发送到会话提问

镜像仅供中文参考，关键公式、数字、实验设置请回原文核对。

## 特性

- **单窗口三栏**：DSH 插件以 `priority: -10` 占据 sidebar 槽，内嵌 iframe 显示阅读页，右侧即原生会话，无需在多个应用间切换
- **双栏联动**：中英 PDF 页码同步、滚轮翻页、适应宽度；原文/镜像可单独翻页后一键对齐
- **选区发问**：在任一栏选中文字 → 发送到右侧会话，自动带论文上下文
- **阅读队列**：AI 可通过五个工具驱动阅读流程（见下），支持「下一篇 / 过 / 状态 / 回写思考」
- **评分与筛选**：`papers.json` 索引带评分，可按分数排序批量精读
- **Obsidian 卡片联动**：阅读思考经 `reader_save_thinking` 追加到论文卡片的「## 阅读思考」小节
- **翻译流水线**（`pipeline/`）：批量评分 → 初筛 → BabelDOC 整篇镜像 → 缺口核查，详见 [docs/WORKFLOW.md](docs/WORKFLOW.md)

## 组成

| 路径 | 说明 |
| --- | --- |
| `dsh-reader/` | DSH 插件：host 半（`index.js`，5 个模型工具）+ client 半（`client.js`，sidebar 面板），纯 JS 无构建 |
| `reader.html` | 阅读页本体：双栏 PDF 渲染、轮询 `/current` 切篇、镜像栏联动 |
| `reader-bridge-standalone.mjs` | 认证回环桥 `http://127.0.0.1:58812`，插件/阅读页/队列工具的服务端 |
| `start-reader-bridge.ps1` | 受守护的桥启动器（发现 DSH renderer origin，失败关闭） |
| `install-bridge-autostart.ps1` | 注册登录自启快捷方式 |
| `launch-reader.ps1` | 为正在运行的 DSH Desktop 启动桥（不打开独立页面） |
| `gen-papers-index.py` / `gen-papers-index-v2.py` | 扫描 PDF 库生成 `papers.json` / `papers.v2.json` 索引（含去重、镜像配对、领域加权评分） |
| `reader-obsidian-navigation.mjs` | Obsidian 论文卡片导航联动 |
| `pipeline/` | 翻译流水线脚本快照（账号/路径为占位符，需自行配置） |
| `vendor/pdfjs/` | PDF.js 运行时 |

## 快速开始

前置：Node.js 20+，Windows（桥用了 Windows ACL 保护 token；其他平台需自行调整），DSH Desktop。

```powershell
cd paper-reader
npm ci
```

1. **启动阅读桥**：`powershell -NoProfile -ExecutionPolicy Bypass -File start-reader-bridge.ps1`
   （可选：运行 `install-bridge-autostart.ps1` 注册登录自启）
2. **安装 DSH 插件**：把 `dsh-reader/` 整个目录拷到 DSH Desktop 的 `profiles/web/node_modules/dsh-reader/`，重启 DSH
3. **生成索引**：按你的 PDF 库布局调整 `gen-papers-index-v2.py` 顶部路径后运行，产出 `papers.v2.json`
4. 在 DSH 侧栏打开「阅读器」面板即可开始；对 AI 说「打开下一篇」即可走队列

### 阅读队列工具（host 半提供）

| 工具 | 用途 |
| --- | --- |
| `reader_open` | 选一篇论文打开（左原文 / 中镜像） |
| `reader_next` | 回写 summary + 标记已读，前进并打开下一篇未读 |
| `reader_skip` | 不回写不标已读，仅前进 |
| `reader_status` | 当前论文 + 队列位置 + 指针处条目 |
| `reader_save_thinking` | 把阅读思考追加到论文卡片 |

## 配置

桥的环境变量（均有默认值，按需覆盖）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_READER_ROOT` | 桥脚本所在目录 | 阅读器根目录（state/queue 存放处） |
| `DSH_READER_LIBRARY_ROOT` | `E:\CLI\llm-wiki` | 论文库根目录（PDF/镜像/卡片） |
| `DSH_READER_THINKING_SCRIPT` | `<库根>/scripts/append_thinking.py` | 思考回写脚本 |
| `DSH_READER_PYTHON` | `%USERPROFILE%\.config\llm-wiki\venv\Scripts\python.exe` | 回写用 Python |
| `DSH_READER_DESKTOP_ORIGIN` | 自动发现 | DSH renderer origin（CDP 探测失败时手动指定） |

数据文件（`papers.json`、`reader-state.json`、`reader-queue.json` 等）是**个人阅读数据**，已在 `.gitignore` 排除，不会也不应提交。

## 安全

- 桥只监听 `127.0.0.1`，不暴露局域网
- 会话 token 存于私有目录（Windows ACL 仅当前用户可读），插件经 `POST /bootstrap` 换 HttpOnly cookie（SameSite=Strict）
- 文件路径白名单校验，PDF 只允许来自库根目录
- **注意**：桥重启会换 token 并使面板 cookie 失效（插件不会自动重取），遇此情况折叠/展开一次 DSH 侧栏面板或重启 DSH 即可

## 测试

```powershell
E:/nodejs/node.exe --test reader-html.test.mjs reader-bridge-standalone.test.mjs reader-obsidian-navigation.test.mjs
cd dsh-reader && E:/nodejs/node.exe --test test.mjs paper-graph-adapter.test.mjs private-session-path.test.mjs
```

## 许可

MIT © qyz7438
