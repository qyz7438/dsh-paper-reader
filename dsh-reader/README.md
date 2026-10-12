# dsh-reader

DSH（DeepSeek Harness，cordis 插件体系）阅读工作区插件，分 host / client 两半：

- **host 半（`index.js`，ESM）**：给会话中的 AI 代理提供五个模型工具；
- **client 半（`client.js`，factory-form CJS）**：以 `priority: -10` 占据 `sidebar` 槽（遮蔽原生 sidebar），列内嵌 iframe 显示阅读桥页面，构成「英文原文 PDF | 中文镜像 PDF | 原生 AI 会话」单窗口三栏。

| 工具 | 用途 |
| --- | --- |
| `reader_open` | 从本地论文索引选一篇论文，`POST /open` 更新阅读桥 current（前端阅读面板随之切换，左 EN / 右 ZH 双栏） |
| `reader_next` | 「下一篇」：可选回写 summary 到当前卡片（来源「DSH 阅读讨论」）+ 标记已读，指针前进，打开下一篇未读 |
| `reader_skip` | 「过」：不回写、不标记已读，仅前进指针并打开下一篇未读 |
| `reader_status` | 阅读桥 current + 队列位置 pointer/total + 指针处论文 slug/title/score/read |
| `reader_save_thinking` | 把一段阅读思考经 `append_thinking.py` 追加到论文卡片的「## 阅读思考」小节 |

交付纯 JS（ESM `.js` + factory-form CJS `client.js`），无构建步骤，Node 20+。

## client 半：sidebar 槽阅读面板

`client.js` 照抄 `dsh-desktop-client-ui/client.js` 的 factory-form CJS 形状（`window.__ModuleLoader__.load({id, factory})`，factory 内 `require('react')`，无 JSX，全部 `React.createElement`），是手写格式而非构建产物。

### 插槽注册细节

- `apply(ctx)` 经 `ctx.slots.inject('sidebar', ...)` 注册 `{ name: 'sidebar', priority: -10 }` + `ReaderPanel`。`SlotCore.entriesOfSlot` 对 single 槽按 priority 升序取每格第一个存活条目，即 **priority 最低者渲染**；原生 sidebar（默认 priority 0）仍在账本上仅被遮蔽，不同 priority 不冲突、不 throw。
- **本注册故意不声明 `children`**。原生子槽（`sidebar.brand.mark` / `sidebar.brand.name` / `sidebar.workspaces` / `sidebar.settings` / `sidebar.footer.action`）的声明归原生 sidebar 条目所有，条目被遮蔽不影响声明存续；重复声明会触发 `SlotCore.register` 的 "already declared" throw（进而触发桌面端槽冲突恢复流程）。面板改为在自身「导航」折叠区里用 props 注入的 `renderSlot` 渲染这些子槽 outlet，工作区导航不丢失。
- 面板结构：顶栏（论文选择器开合钮、论文标题、「选中 PDF 文字可发送到会话」提示标签、明/暗切换钮、「导航」折叠钮、「独立窗口」按钮 → `POST /open {…current, target:'window'}`）+ 可折叠「导航」区 + 可重试的桥错误条 + 主体行（**论文选择器列** | 6px 拖拽手柄 | iframe 阅读区 | 右缘 6px 列宽手柄）+ toast 浮层。
- 面板每 2s 轮询 `GET /current` 与 `GET /papers`（选择器数据源；失败保留旧列表，桥不可达时显示错误条）。嵌入 iframe 使用 `http://127.0.0.1:58812/?theme=dark|light`，由阅读页自身跟随 `/current` 更新 PDF、规范卡片和概念/任务/方法入口；切换论文保持 iframe 实例。带显式 `left` 或 `right` 的独立 URL 继续作为静态 PDF 阅读页。
- 折叠窄栏态（`collapsed` prop）只渲染一个「阅读器」竖排按钮，点击调 `ctx.layout.toggleSidebar()` 展开；挂载时若处于折叠态会自动展开一次。

### 论文选择器列

- 默认展开 260px（可拖 180–420px，localStorage `dsh-reader.selectorWidthPx` 持久化）；顶栏「收起论文」或折叠后窄条上的「论文」竖排钮开合。
- 数据来自 `GET /papers` → `{papers:[{slug,title,score,read,hasZh}], current:{slug,updatedAt}, queue:{pointer,total}}`：搜索框按 slug/title 子串过滤（大小写不敏感）、列表按 score 降序（缺分最后）、已读灰显/未读加粗、`hasZh:false` 显示「无镜像」、`current.slug` 高亮（底色 + accent 左边条）、底部显示队列进度 `pointer+1/total`（无队列信息时显示总数）。
- 点击论文：`POST /select {slug}`，成功后立即更新面板的 `current`；嵌入页在下一次 `/current` 轮询切换 PDF 和网络上下文，iframe 本身不重载。选择器把提示词注入会话 composer（注入不发送）：
  ```
  读论文《<title>》
  - 原文: <current.left>
  - 镜像: <current.right 或 "无">
  - 卡片: <paper.card 或 "无">
  先给我三段式导读，再陪我逐节读。
  ```
  `/papers` 还返回稳定 `paper_id`、`canonicalCard` 与网络入口；原文/镜像路径取自 `/select` 响应的 `current.left/right`。无法打开的原文或身份冲突会明确拒绝，`/select` 失败（`ok:false` 或非 2xx）toast 报错、不注入。

### composer 注入（侦察结论 + 最终方式）

**找到了稳定 API，未走剪贴板退化以外的 hack。** 侦察文件（打包应用 `E:\DSH1\DSH Desktop\resources\app\node_modules\@deepseek-ai\`）：

| 文件 | 行号（约） | 结论 |
| --- | --- | --- |
| `dsh-client-ui-conversation/lib/client.js` | 11496–11510 | `SessionInputShell.actions` 公共面 = `{ setDraft, addImages, removeImage, pruneImages, submit }` |
| 同上 | 11627–11643 | `setDraft(text)`：整段替换草稿、按行切段、光标落文末、**不发送** |
| 同上 | 16053–16068 | `ctx.uiSession.provide({ hooks:['conversation','input'], props:['inputActions'], resolve })`：每个会话 binding 的 `props.inputActions` = `shell.actions`，`hooks.input` = `shell.state` 快照 store（含 `draft`） |
| `dsh-client-ui-session/lib/client.js` | 72–115 | `UiSession` 服务（服务名 `uiSession`），`adapter.current.getSnapshot()` → 当前 binding `{ key, ctx, hooks, props }`（无会话时为 absent binding，`props.inputActions` 为 `undefined`） |

最终注入方式（`insertIntoComposer(ctx, text)`，选文与 PDF 选中两个入口共用）：

```js
const binding = ctx.get('uiSession').adapter.current.getSnapshot()
const prev = binding.hooks.input.getSnapshot().draft   // 现有草稿
binding.props.inputActions.setDraft(mergeDraft(prev, text))  // 非空则空行分隔追加
```

`uiSession` 不在 `inject` 中声明（保持 `inject = ['slots','layout']` 的最小依赖），运行时 `ctx.get('uiSession')` 懒取；服务缺失、无活动会话或任一步抛错时退化为 `navigator.clipboard.writeText` + toast「已复制到剪贴板，粘贴到输入框即可」，剪贴板也不可用则 toast 注入失败。`test.mjs` 内含静态验证（正则核对打包应用源码中上述三处调用路径仍存），路径漂移会 FAIL。

另侦察到会话域事件 `slash/input-insert-text`（`dsh-client-ui-conversation` 12317 行 `actx.on(...)`，`dsh-client-ui-input-trigger` 611 行 `actx.bail(...)` 发出）可插文本到光标处，但需拿到 session 作用域 ctx（`ctx.sessions.scope(id)`），比 `inputActions.setDraft` 多一层间接且语义是「插入」而非「整段替换」，未采用。

### PDF 选中文本进入会话

- 面板 `window.addEventListener('message')` 只收 `event.origin === 'http://127.0.0.1:58812'` 且 `data.source === 'dsh-reader'` 的消息；`type:'selection'`（`{text, page, title}`）经 `parseSelectionMessage` 校验后调 `insertIntoComposer`，文本形如：
  ```
  【《<title>》p.<page>】
  > <text>
  ```
  （引用块，setDraft 光标落文末，方便直接追问；已有草稿时空行分隔追加。）
- `type:'theme'`（`{theme:'dark'|'light'}`）被采纳：调 `ctx.theme.setTheme`（三处一致：reader 内钮 → 面板 → DSH 全局）。

### 暗色主题

侦察 `dsh-client-ui-theme/lib/client.js`：`apply` 内 `ctx.provide("theme", theme)`（ThemeRuntime，~1471 行）；`getTheme().active.colorScheme` → `'dark'|'light'`（`preference:'system'` 时已解析，`buildSnapshot` ~1377 行）；变化经 `ctx.emit("theme/change", snapshot)`（~1408 行）广播；`setTheme('light'|'dark')` 写用户偏好。主题**不挂在** documentElement 的 data-theme/class 上（那是安装样式表的内部细节），服务快照是唯一可靠读口。

面板：`ctx.get('theme')` + `ctx.on('theme/change')` 驱动明暗双态（暗色 `#16181d/#1d2026` 系，覆盖选择器列/顶栏/错误条/手柄/toast）；服务缺失退化 `matchMedia('(prefers-color-scheme: dark)')`。主题经 **双通道** 同步给 reader.html：iframe src 的 `&theme=dark|light` 参数（覆盖重载场景）+ `postMessage({source:'dsh-reader-panel', type:'theme', theme}, BRIDGE)`（覆盖运行时切换）。顶栏明/暗钮调 `setTheme` 切 DSH 全局偏好，与 reader 内钮双向一致。

### 列宽方案（DOM 兜底，已核实无可靠 store API）

layout store 的 `setSidebar` action 被 `clampWidth(px, 264, 420)` 钳制（见 `dsh-client-ui-layout/lib/client.js` 的 `createLayoutStore`），sidebar 列不可能经 store 拉到 ~62% 视口宽；`ctx.layout` 服务面（`LayoutController`）只暴露 `toggleSidebar/openDetails/closeDetails`。因此面板挂载后沿 DOM 向上找到带内联 `gridTemplateColumns` 的 AppFrame 元素，改写首列轨道（默认 `min(62% 视口, 视口-480px)` 下限 420px；localStorage `dsh-reader.sidebarWidthPx` 有值时用保存值并钳制 260–75% 视口），并监听 resize 重算。**面板右缘自绘 6px 拖拽手柄**：拖动期间 `document.body.style.userSelect='none'` 且 iframe `pointer-events:none`（防 iframe 吃事件），mousemove 直接改写首列轨道（260px–75% 视口），松手写 localStorage。选择器列与阅读区之间另有同机制手柄（180–420px，localStorage `dsh-reader.selectorWidthPx`）。用户拖动原生手柄或打开 details 列时 React 会以 store 值重写内联样式，列宽控制权天然交还用户（可用本面板手柄再拖回）；面板卸载时恢复原值。三个拖拽（选择器列/阅读列/PDF 内中英分栏由 reader.html 负责）互不干扰。

## 依赖决策（schemastery / dsh-tools）

已确认打包应用 `DSH Desktop/resources/app/node_modules/@deepseek-ai/` 下**存在** `schemastery`（3.18.2，ESM 入口 `lib/index.mjs`）与 `dsh-tools`（0.1.2-rc.1，导出 `defineTool`）。

但本插件目录位于应用树之外，裸标识符 `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-tools` 能否解析取决于主代理最终采用的挂载方式（cordis loader 的解析根），插件自身无法保证。因此 `index.js` 的策略是：

1. **优先** `import('@deepseek-ai/schemastery')` 与 `import('@deepseek-ai/dsh-tools')`（顶层 await，失败静默）——在应用内解析成功时，Config 校验与工具参数校验完全走一方实现；
2. **退化**为零依赖内置实现——Config 用手写的 standard-schema 校验器（cordis 只依赖 `Config['~standard'].validate(config)` 同步接口，已在打包应用 `cordis/lib/index.js` 的 `resolveConfig` 中核实），`defineTool` 用对照打包应用 `dsh-tools/lib/index.js` 行为手写的小型等价物（参数 spec → JSON Schema、执行前校验）。

因此本目录**不需要 node_modules**，两种环境下行为一致。

## 配置

cordis `Config` schema（全部带默认值，均可省略）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | `http://127.0.0.1:58812` | DSH 阅读桥（Electron 侧 HTTP 服务）地址 |
| `papersPath` | `E:/DSH1/paper-reader/papers.json` | 论文索引 JSON 绝对路径 |
| `queuePath` | `E:/DSH1/paper-reader/reader-queue.json` | 阅读队列 JSON 绝对路径（不存在时按 papers.json 顺序初始化） |
| `pythonCmd` | `python` | Python 启动命令 |
| `appendScript` | `E:/CLI/llm-wiki/scripts/append_thinking.py` | 思考回写脚本绝对路径 |

host 半声明 `inject = ['tools']`（cordis 工具注册表先行挂载）；client 半声明 `inject = ['slots', 'layout']`，`package.json` 的 `dsh.client` 声明 `platform: web`、`inject: ['@deepseek-ai/dsh-client-ui-layout']`，并导出 `exports['./client']`。

## 论文索引（papers.json）契约

文件为**数组**（顺序即 rank 顺序，1 基），或含 `papers` 数组的对象。每项：

```json
{
  "slug": "attention-is-all-you-need",
  "title": "Attention Is All You Need",
  "score": 95.27,
  "read": false,
  "pdfEn": "E:/DSH1/paper-reader/papers/attention.en.pdf",
  "pdfZh": "E:/DSH1/paper-reader/papers/attention.zh.pdf",
  "card": "E:/CLI/llm-wiki/_wiki/references/papers/论文-attention.md",
  "arxiv": "2606.25324"
}
```

- `title` 必填（缺失时退化为 slug 或 `paper-N`）；`pdfEn` 必填（缺失则该篇报 `no_pdf`）；`pdfZh` 可省略（单栏打开）。
- `score` / `read` 可选：`read: true` 的论文在「下一篇」「过」流程中被跳过；`score` 随 `reader_next` / `reader_status` 返回。
- 容忍 snake_case 变体 `pdf_en` / `pdf_zh`。

## 阅读队列（reader-queue.json）契约

```json
{ "pointer": 0, "order": ["slug-1", "slug-2", "..."] }
```

- 不存在或损坏时按 papers.json 的 papers 数组顺序初始化并立即落盘（id 取 `slug ?? title`）。
- `pointer` 指向当前论文；`reader_next` / `reader_skip` 前进到下一个 `read !== true` 的条目并持久化。

## 工具契约

### `reader_open`

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 否 | 标题/slug 子串（大小写不敏感）；与 `rank` 同时给出时以 `rank` 为准 |
| `rank` | integer | 否 | 索引排序后第 N 篇（1 基） |
| `page` | integer | 否 | 打开后跳转的 PDF 页码（1 基） |

行为：

1. 读取 `papersPath`，按上述契约解析；
2. `rank` 越界 → `rank_out_of_range`；`query` 无命中 → `not_found`；**多候选 → 返回候选列表，不打开**（`error: "ambiguous"`）；两者都缺 → `missing_selector`；
3. 选中后 `POST <bridgeUrl>/open`，body `{"left": pdfEn, "right": pdfZh?, "page"?: n, "title"}`（不带 `target`，只更新桥 current，前端面板轮询后切换），超时 5 秒；
4. 成功返回 `{ok: true, title, slug?, rank, left, right?, page?, bridgeStatus, bridgeBody}`。

失败一律返回结构化值（不抛异常），`error` 取值：

| `error` | 含义 |
| --- | --- |
| `index_unavailable` / `index_invalid` | 索引文件读不到 / 解析失败 |
| `invalid_rank` / `rank_out_of_range` / `missing_selector` | 参数问题 |
| `not_found` / `ambiguous` | 选择问题（ambiguous 附 `candidates: [{rank, slug?, title}]`） |
| `no_pdf` | 该篇缺 `pdfEn` |
| `bridge_unavailable` | 连接被拒 / 超时，message 固定为「DSH 阅读桥未就绪，请重启 DSH Desktop」 |
| `bridge_error` | 桥返回非 2xx，附 `status` |

### `reader_next`

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `summary` | string | 否 | 对当前论文的阅读小结（Markdown）；给出且指针处有论文时先回写再前进 |
| `question` | string | 否 | 本次讨论的问题，随 summary 写入 |

行为：

1. 读索引 + 队列（缺则初始化）；
2. 给了 `summary` 且指针处有论文：先 `append_thinking.py <当前 slug> --stdin [--question Q] --source "DSH 阅读讨论"` 回写当前卡片，再 `POST /read {path: pdfEn, read: true}` 标记已读（任一步失败则不前进队列，返回该步的结构化错误）；
3. 指针前进到下一个 `read !== true` 的条目（无 pdfEn 的条目视同已读跳过），持久化队列，`POST /open` 更新 current；
4. 成功返回 `{ok: true, archived, current: {slug?, title}, next: {slug?, title, score?, rank}}`；到末尾（回写仍完成）返回 `{ok: false, error: 'end_of_queue', archived, current}`。

### `reader_skip`

无参数。不回写、不标记已读，仅前进指针（同样跳过 `read: true`）并 `POST /open` 更新 current。返回 `{ok: true, current, next}`；到末尾返回 `{ok: false, error: 'end_of_queue'}`。

### `reader_status`

无参数。返回 `{ok: true, bridgeAvailable, current, queue: {pointer, total}, paper?: {slug?, title, score?, read}}`；桥不可达时 `bridgeAvailable: false`、`current` 为 `{}` 并附 `detail`，队列信息照常返回。

### `reader_save_thinking`

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | **是** | 定位卡片的标题/slug 子串 |
| `text` | string | **是** | 思考正文（Markdown），写进子进程 stdin |
| `question` | string | 否 | 本次讨论的问题 |

行为：`spawn <pythonCmd> <appendScript> <query> --stdin [--question Q] --source "DSH 阅读器"`，`text` 写 stdin，30 秒超时（`reader_next` 内部回写用来源「DSH 阅读讨论」）。

返回 `{ok, stdout, stderr, ...}`；失败 `error` 取值：`python_unavailable`（命令不存在/无法启动）、`script_failed`（非零退出，附 `exitCode`）、`python_timeout`。

## 挂载方式

> **占位 —— 待主代理集成时确定。** 预期在 patch yml 的 entry list 中追加一项指向本目录 `index.js` 的插件条目（cordis object plugin：`{ name: 'dsh-reader', inject: ['tools'], Config, apply }`），config 可覆盖上表五个键；client 半经 `package.json` 的 `dsh.client` 声明 + `exports['./client']` 由 web 侧 loader 加载。插件挂载与部署目录同步由主代理统一操作，本目录不含也不修改任何 patch yml，也不直接改 `dsh-desktop-data` 部署副本。

## 验证

```bash
node test.mjs
node --check client.js
```

`test.mjs` 不依赖 Electron：mock 127.0.0.1 随机空闲端口 HTTP 桥（记录 `POST /open`、`POST /read`，服务 `GET /current`）+ 临时 papers.json（3 篇假论文，中间一篇 `read: true`）+ 临时 reader-queue.json，覆盖：

- `reader_open` 的 rank / query / 多候选 / 桥不可达四条路径；
- `reader_save_thinking` 的 Python 不可用路径；本机 Python 可用时再用真实 `append_thinking.py` 验证一个必不命中的 query（脚本报「未找到匹配卡片」退出码 1，**不写入任何真实卡片**）；
- `reader_status` 的队列初始化与落盘、指针处论文字段；
- `reader_next` 的回写（query=当前 slug、source=「DSH 阅读讨论」、带 question，经 node 假 append 脚本断言）+ 标记已读 + 跳过 `read: true` + 打开下一篇 + pointer 持久化，以及末尾 `end_of_queue`（回写仍完成）；
- `reader_skip` 的不回写/不标记已读 + 前进 + 末尾 `end_of_queue`；
- 末尾另有一段一方依赖集成验证：通过绝对 file URL 导入打包应用内真实的 schemastery / dsh-tools，重放与 `index.js` 相同的 Config / defineTool 调用形状。

当前 63/63 通过。

`client.js` 无法在无浏览器环境跑组件级单测，但全部非 DOM 逻辑拆成了纯函数核（`globalThis.__DSH_READER_PANEL_CORE__`：过滤/排序/拖拽数学/钳制/提示词与引用块文本/消息校验/主题快照解析/草稿合并/队列格式/`insertIntoComposer`），`test.mjs` 直接 import client.js（window 缺失时跳过 loader 注册）并覆盖这些纯函数；另有一段 **composer/主题 API 静态验证**：正则核对打包应用 `dsh-client-ui-conversation` / `dsh-client-ui-session` / `dsh-client-ui-theme` 源码中本面板依赖的调用路径（`inputActions.setDraft` 公共面、`uiSession` 服务名与 current binding 快照、`ctx.provide("theme", …)` 与 `theme/change` 事件）仍然存在，上游漂移即 FAIL。`node --check` 校验语法（factory-form CJS，虽处在 `"type": "module"` 包内，但不含任何 ESM/CJS 互斥语法，两种解析目标均可通过）。

## 部署后验证步骤（需运行中的 DSH Desktop）

1. 主代理将本目录同步到部署副本 `E:\DSH1\dsh-desktop-data\profiles\web\plugins\dsh-reader\` 后，重启 DSH Desktop；
2. 确认左侧栏变为阅读面板：顶栏「收起论文 / DSH 阅读器 / 提示标签 / 深色·浅色 / 导航 / 独立窗口」，主体行为「论文选择器列 + iframe 阅读区」，列宽约为视口 62%；
3. **论文选择器**：搜索框输入 slug/标题子串过滤即时生效；列表按分数降序、已读灰显未读加粗、无镜像标注、当前篇高亮、底部队列进度；点「收起论文」变窄条，窄条「论文」钮恢复；
4. **点击论文注入**：点击列表中一篇 → 阅读页在下一轮 `/current` 切换 PDF 和网络入口（iframe 不重载）+ toast「已注入会话输入框」+ 当前会话 composer 出现四行提示词（`读论文《…》/ 原文 / 镜像 / 卡片 / 先给我三段式导读…`），**未自动发送**；composer 已有内容时被空行分隔追加而非覆盖；无活动会话时 toast 变为「已复制到剪贴板…」，Ctrl+V 可粘贴；
5. **PDF 选中注入**：在 PDF 上选中文字点「发送到会话」→ composer 追加 `【《标题》p.N】> 选文` 引用块，光标在其后可直接追问；
6. **暗色主题**：顶栏点「深色」→ DSH 全局、面板 chrome（选择器列/顶栏/错误条）、reader.html 三处同步变暗；reader 内钮切回浅色时面板与 DSH 同步恢复（postMessage 双向一致）；
7. **拖拽列宽**：选择器列右缘手柄拖 180–420px，刷新后保持；面板右缘手柄拖整列 260px–75% 视口，刷新后保持；拖原生手柄后仍可用面板手柄拖回；
8. 在会话中说「打开第 3 篇」：`reader_open` → `POST /open` → 面板轮询 `/current` 判变后切换 iframe；
9. 讨论后说「下一篇」并附小结：当前卡片「## 阅读思考」新增一条（来源「DSH 阅读讨论」），面板切到下一篇未读；说「过」则直接切换不回写；
10. 点「导航」展开原生子槽（工作区列表/设置），确认原生导航可用；点「独立窗口」弹出原生阅读窗口；
11. 停掉阅读桥（或桥未起时）：面板出现可重试的错误条，「重试」恢复；选择器列表保留最后一次成功数据。
