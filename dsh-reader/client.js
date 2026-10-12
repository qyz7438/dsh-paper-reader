/**
 * dsh-reader client half: DSH 前端常驻三栏阅读工作区的 sidebar 槽占据者。
 *
 * 形状照抄 dsh-desktop-client-ui/client.js 的 factory-form CJS（手写格式，
 * 非构建产物）：window.__ModuleLoader__.load({ id, factory })，factory 内
 * require('react')，无 JSX，全部走 React.createElement。文件同时可被 node
 * 以 ESM 语法 import（无 window 时跳过 loader 注册），纯函数经
 * globalThis.__DSH_READER_PANEL_CORE__ 暴露给 test.mjs 单测。
 *
 * 插槽策略（关键决策，勿随意改回）：
 *  - 以 priority: -10 注册进 'sidebar'（single 槽）。SlotCore.entriesOfSlot
 *    按 priority 升序取每格第一个存活条目，即 priority 最低者渲染；原生
 *    sidebar（dsh-client-ui-sidebar，默认 priority 0）仍在账本上，仅被遮蔽，
 *    不触发同 priority 冲突 throw。
 *  - 本注册【故意不声明 children】。原生子槽（sidebar.brand.mark /
 *    sidebar.brand.name / sidebar.workspaces / sidebar.settings /
 *    sidebar.footer.action）由原生 sidebar 条目的 children 表声明；条目被
 *    遮蔽不影响其声明存续。若此处照抄 children，SlotCore.register 会对已
 *    声明子槽抛 "slot ... is already declared"，进而触发桌面端槽冲突恢复
 *    流程——这是必须避免的。我们改为在自己的面板里用 renderSlot 渲染这些
 *    子槽 outlet（可折叠「导航」区），工作区导航不丢失。
 *
 * 面板结构：顶栏（论文选择器开合钮、标题、提示标签、明/暗钮、导航钮、
 * 独立窗口钮）+ 可折叠「导航」区 + 桥错误条 + 主体行（论文选择器列
 * [可折叠/可拖宽 180–420px] | 拖拽手柄 | iframe 阅读区 | 右缘 6px 列宽手柄）。
 *
 * 列宽方案（DOM 兜底，已核实无可靠 store API）：layout store 的 setSidebar
 * action 被 clampWidth(px, 264, 420) 钳制（见 dsh-client-ui-layout/lib/client.js
 * 的 createLayoutStore），不可能达到约 62% 视口宽；ctx.layout 服务面只暴露
 * toggleSidebar/openDetails/closeDetails。因此挂载后向上找到带内联
 * gridTemplateColumns 的 AppFrame 元素并改写首列轨道；面板右缘自绘 6px
 * 拖拽手柄直接改写该轨道（260px–75% 视口），松手写入 localStorage 下次恢复；
 * 用户拖动原生手柄或打开 details 列时 React 会以 store 值重写内联样式，
 * 列宽控制权天然交还用户（此时可用本面板手柄再拖回）。卸载时恢复原值。
 *
 * composer 注入（侦察结论见 README）：稳定路径是
 *   ctx.get('uiSession').adapter.current.getSnapshot().props.inputActions.setDraft(text)
 * —— uiSession 服务（dsh-client-ui-session）的 current binding 携带
 * ui-conversation 经 provide 通道暴露的 SessionInputShell.actions 公共面
 * （{ setDraft, addImages, removeImage, pruneImages, submit }），setDraft 整段
 * 替换草稿、光标落文末、不发送；现有草稿非空时追加（空行分隔）。服务缺失
 * 或无活动会话时退化为剪贴板复制 + toast 提示。
 *
 * 主题：ctx.get('theme')（dsh-client-ui-theme 的 ThemeRuntime 服务）
 * getTheme().active.colorScheme 得 'dark'|'light'，ctx.on('theme/change')
 * 订阅变化；服务缺失时退化 matchMedia('(prefers-color-scheme: dark)')。
 * 明/暗钮调 setTheme 切换 DSH 全局偏好；主题经 iframe src 的 &theme= 参数
 * + postMessage {source:'dsh-reader-panel', type:'theme'} 双通道同步给
 * reader.html；iframe 回发的 {source:'dsh-reader', type:'theme'} 亦被采纳
 * （reader 内钮 → 面板 → DSH 全局，三处一致）。
 */

/* ------------------------------------------------------------------ */
/* 纯函数核（无 DOM/React 依赖，test.mjs 直接单测）                     */
/* ------------------------------------------------------------------ */

const BRIDGE = 'http://127.0.0.1:58812'
const POLL_MS = 2000
const FONT = '"Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif'
const LS_SIDEBAR_WIDTH = 'dsh-reader.sidebarWidthPx'
const LS_SELECTOR_WIDTH = 'dsh-reader.selectorWidthPx'
const SELECTOR_MIN = 180
const SELECTOR_MAX = 420
const SIDEBAR_MIN = 260
const SIDEBAR_RATIO_MAX = 0.75

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** slug/title 子串过滤（大小写不敏感；空串返回全部）。 */
function filterPapers(papers, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return papers
  return papers.filter((paper) => {
    const slug = typeof paper.slug === 'string' ? paper.slug.toLowerCase() : ''
    const title = typeof paper.title === 'string' ? paper.title.toLowerCase() : ''
    return slug.includes(needle) || title.includes(needle)
  })
}

/** 按 score 降序（缺失/非有限值排最后；现代 JS sort 稳定，同分保持原序）。 */
function sortByScore(papers) {
  const rank = (paper) => (Number.isFinite(paper.score) ? paper.score : Number.NEGATIVE_INFINITY)
  return [...papers].sort((a, b) => rank(b) - rank(a))
}

/** 拖拽数学：起点宽 + 位移，钳制在 [min, max]。 */
function dragWidth(startWidth, startX, clientX, min, max) {
  return clamp(startWidth + (clientX - startX), min, max)
}

/** sidebar 列默认宽：约 62% 视口，给会话列留至少 480px，下限 420px。 */
function defaultSidebarWidth(viewport) {
  return Math.max(420, Math.min(Math.round(viewport * 0.62), viewport - 480))
}

/** sidebar 列拖拽钳制：260px–75% 视口。 */
function clampSidebarWidth(px, viewport) {
  return clamp(px, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, Math.round(viewport * SIDEBAR_RATIO_MAX)))
}

/** 选中文论注入 composer 的提示词文本（注入不发送）。 */
function buildPaperPrompt(input) {
  const title = typeof input.title === 'string' && input.title.length > 0 ? input.title : '未命名论文'
  const pdfEn = typeof input.pdfEn === 'string' && input.pdfEn.length > 0 ? input.pdfEn : '无'
  const pdfZh = typeof input.pdfZh === 'string' && input.pdfZh.length > 0 ? input.pdfZh : '无'
  const card = typeof input.card === 'string' && input.card.length > 0 ? input.card : '无'
  return `读论文《${title}》\n- 原文: ${pdfEn}\n- 镜像: ${pdfZh}\n- 卡片: ${card}\n先给我三段式导读，再陪我逐节读。`
}

/** PDF 选中文本注入 composer 的引用块文本（光标经 setDraft 落于文末，方便追问）。 */
function buildQuoteText(input) {
  const title = typeof input.title === 'string' && input.title.length > 0 ? input.title : '论文'
  const page = Number.isFinite(input.page) ? input.page : '?'
  const text = String(input.text ?? '').trim()
  return `【《${title}》p.${page}】\n> ${text}\n`
}

/** 校验并解析 iframe 的 selection postMessage；不合法返回 null。 */
function parseSelectionMessage(data) {
  if (data === null || typeof data !== 'object') return null
  if (data.source !== 'dsh-reader' || data.type !== 'selection') return null
  if (typeof data.text !== 'string' || data.text.trim() === '') return null
  return {
    text: data.text,
    page: Number.isFinite(data.page) ? data.page : null,
    title: typeof data.title === 'string' ? data.title : '',
  }
}

/** 校验并解析 iframe 的 theme postMessage；只认 'dark'|'light'，否则 null。 */
function parseThemeMessage(data) {
  if (data === null || typeof data !== 'object') return null
  if (data.source !== 'dsh-reader' || data.type !== 'theme') return null
  return data.theme === 'dark' || data.theme === 'light' ? data.theme : null
}

/** 从 ThemeRuntime 快照取 'dark'|'light'；形状不符返回 null。 */
function resolveThemeName(snapshot) {
  const scheme = snapshot !== null && typeof snapshot === 'object' && snapshot.active !== null
    && typeof snapshot.active === 'object' ? snapshot.active.colorScheme : undefined
  return scheme === 'dark' || scheme === 'light' ? scheme : null
}

/** 草稿合并：已有草稿非空时以空行分隔追加，否则直接写入。 */
function mergeDraft(prev, text) {
  const before = String(prev ?? '')
  return before.trim() === '' ? text : `${before.replace(/\s+$/u, '')}\n\n${text}`
}

/** 队列进度文本（pointer 0 基，显示 1 基）；信息不足返回 null。 */
function formatQueue(queue) {
  if (queue === null || typeof queue !== 'object') return null
  if (!Number.isInteger(queue.pointer) || !Number.isInteger(queue.total) || queue.total <= 0) return null
  return `${queue.pointer + 1}/${queue.total}`
}

/** The embedded reader follows its authenticated /current state. Keep static
 * PDF identity out of its URL so a stale panel render cannot become a
 * standalone document with another paper's identity. */
function buildEmbeddedReaderUrl(bridge, theme) {
  const query = new URLSearchParams()
  query.set('theme', theme === 'light' ? 'light' : 'dark')
  return `${bridge}/?${query.toString()}`
}

/** cordis 可选服务读取（inject 不声明，缺失时各功能自行退化）。 */
function getService(ctx, name) {
  try {
    if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') return ctx.get(name)
  } catch { /* 服务未接线 */ }
  return undefined
}

/**
 * composer 注入（选文与 PDF 选中两个入口共用）。
 * 返回 'composer'（已注入输入框）/ 'clipboard'（退化剪贴板）/ 'failed'。
 */
function insertIntoComposer(ctx, text) {
  try {
    const uiSession = getService(ctx, 'uiSession')
    const adapter = uiSession !== undefined && uiSession !== null ? uiSession.adapter : undefined
    const binding = adapter !== undefined && adapter !== null && adapter.current !== undefined
      && typeof adapter.current.getSnapshot === 'function' ? adapter.current.getSnapshot() : undefined
    const actions = binding !== undefined && binding !== null && binding.props !== undefined
      && binding.props !== null ? binding.props.inputActions : undefined
    if (actions !== undefined && actions !== null && typeof actions.setDraft === 'function') {
      let prev = ''
      const inputHook = binding.hooks !== undefined && binding.hooks !== null ? binding.hooks.input : undefined
      if (inputHook !== undefined && inputHook !== null && typeof inputHook.getSnapshot === 'function') {
        const snapshot = inputHook.getSnapshot()
        if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.draft === 'string') prev = snapshot.draft
      }
      actions.setDraft(mergeDraft(prev, text))
      return 'composer'
    }
  } catch { /* 落到剪贴板退化 */ }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(text)
      return 'clipboard'
    }
  } catch { /* 剪贴板亦不可用 */ }
  return 'failed'
}

const PANEL_CORE = {
  BRIDGE,
  clamp,
  filterPapers,
  sortByScore,
  dragWidth,
  defaultSidebarWidth,
  clampSidebarWidth,
  buildPaperPrompt,
  buildQuoteText,
  parseSelectionMessage,
  parseThemeMessage,
  resolveThemeName,
  mergeDraft,
  formatQueue,
  buildEmbeddedReaderUrl,
  insertIntoComposer,
}
if (typeof globalThis !== 'undefined') globalThis.__DSH_READER_PANEL_CORE__ = PANEL_CORE

/* ------------------------------------------------------------------ */
/* Web 侧注册（node import 时 window 缺失，跳过）                        */
/* ------------------------------------------------------------------ */

if (typeof window !== 'undefined' && window.__ModuleLoader__
  && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-reader',
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      const React = require('react')
      const h = React.createElement
      let bridgeBootstrap = null
      const bootstrapBridge = () => {
        if (bridgeBootstrap === null) {
          bridgeBootstrap = fetch(`${BRIDGE}/bootstrap`, { method: 'POST', credentials: 'include', cache: 'no-store' })
            .then((response) => {
              if (!response.ok) throw new Error(`reader bootstrap HTTP ${response.status}`)
            })
            .catch((error) => {
              bridgeBootstrap = null
              throw error
            })
        }
        return bridgeBootstrap
      }
      const bridgeFetch = async (path, options = {}) => {
        if (path !== '/bootstrap') await bootstrapBridge()
        return fetch(`${BRIDGE}${path}`, { ...options, credentials: 'include', cache: options.cache || 'no-store' })
      }

      /* 明暗双态配色（暗色用 #16181d/#1d2026 系） */
      const PALETTES = {
        light: {
          bg: '#f6f3ec',
          bar: '#fdfcf8',
          border: '#e2dccb',
          text: '#33302a',
          dim: '#8a8272',
          accent: '#4a6741',
          btnBg: '#f1ede2',
          hoverBg: '#efe9db',
          currentBg: '#e7e2d2',
          inputBg: '#ffffff',
          errorBg: '#fbeaea',
          errorText: '#9b3535',
          handle: '#d6cfbc',
          iframeBg: '#ffffff',
        },
        dark: {
          bg: '#16181d',
          bar: '#1d2026',
          border: '#2c313a',
          text: '#d7dade',
          dim: '#7d8590',
          accent: '#7fb069',
          btnBg: '#23272e',
          hoverBg: '#242932',
          currentBg: '#2a3038',
          inputBg: '#12141a',
          errorBg: '#3a2224',
          errorText: '#e08b8b',
          handle: '#333a44',
          iframeBg: '#16181d',
        },
      }

      function makeStyles(P) {
        return {
          root: {
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: P.bg,
            color: P.text,
            fontFamily: FONT,
            fontSize: 13,
            overflow: 'hidden',
            position: 'relative',
          },
          topbar: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            background: P.bar,
            borderBottom: `1px solid ${P.border}`,
            flex: '0 0 auto',
          },
          title: {
            flex: '1 1 auto',
            minWidth: 0,
            fontWeight: 600,
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
          hint: {
            flex: '0 0 auto',
            fontSize: 11,
            color: P.dim,
            whiteSpace: 'nowrap',
          },
          btn: {
            flex: '0 0 auto',
            fontFamily: FONT,
            fontSize: 12,
            color: P.text,
            background: P.btnBg,
            border: `1px solid ${P.border}`,
            borderRadius: 6,
            padding: '3px 10px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
          nav: {
            flex: '0 0 auto',
            padding: '6px 10px 8px',
            background: P.bar,
            borderBottom: `1px solid ${P.border}`,
          },
          errorBar: {
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            background: P.errorBg,
            color: P.errorText,
            fontSize: 12,
            borderBottom: `1px solid ${P.border}`,
          },
          body: {
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'row',
            minHeight: 0,
            minWidth: 0,
          },
          selector: {
            flex: '0 0 auto',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: P.bar,
            borderRight: `1px solid ${P.border}`,
          },
          search: {
            flex: '0 0 auto',
            margin: '8px 8px 6px',
            padding: '4px 8px',
            fontFamily: FONT,
            fontSize: 12,
            color: P.text,
            background: P.inputBg,
            border: `1px solid ${P.border}`,
            borderRadius: 6,
            outline: 'none',
          },
          list: {
            flex: '1 1 auto',
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '0 4px 4px',
          },
          queueBar: {
            flex: '0 0 auto',
            padding: '6px 10px',
            fontSize: 11,
            color: P.dim,
            borderTop: `1px solid ${P.border}`,
          },
          handle: {
            flex: '0 0 auto',
            width: 6,
            cursor: 'col-resize',
            background: 'transparent',
            borderLeft: `1px solid transparent`,
          },
          reader: {
            flex: '1 1 auto',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
          },
          empty: {
            flex: '1 1 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            color: P.dim,
            fontSize: 13,
            lineHeight: 1.9,
            padding: 24,
          },
          rail: {
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 10,
            background: P.bg,
          },
          strip: {
            flex: '0 0 auto',
            width: 26,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 8,
            background: P.bar,
            borderRight: `1px solid ${P.border}`,
          },
          toast: {
            position: 'absolute',
            left: '50%',
            bottom: 18,
            transform: 'translateX(-50%)',
            background: P.bar,
            color: P.text,
            border: `1px solid ${P.border}`,
            borderRadius: 8,
            padding: '6px 14px',
            fontSize: 12,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            zIndex: 10,
            whiteSpace: 'nowrap',
          },
        }
      }

      function readWidth(key) {
        try {
          const raw = window.localStorage.getItem(key)
          const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
          return Number.isFinite(parsed) ? parsed : null
        } catch {
          return null
        }
      }

      function writeWidth(key, px) {
        try {
          window.localStorage.setItem(key, String(Math.round(px)))
        } catch { /* 隐私模式等场景忽略 */ }
      }

      function formatScore(score) {
        return Number.isFinite(score) ? score.toFixed(1) : ''
      }

      /**
       * 阅读面板。插槽渲染器会向条目组件注入 renderSlot / collapsed / width 等
       * props（参照 SidebarRoot 的签名）；ctx 经 apply 闭包传入。
       */
      function createReaderPanel(ctx) {
        return function ReaderPanel(props) {
          const renderSlot = typeof props.renderSlot === 'function'
            ? props.renderSlot
            : () => null
          const rootRef = React.useRef(null)
          const frameRef = React.useRef(null)
          const iframeRef = React.useRef(null)
          const [current, setCurrent] = React.useState(null)
          const [bridgeError, setBridgeError] = React.useState(null)
          const [navOpen, setNavOpen] = React.useState(false)
          const [papers, setPapers] = React.useState([])
          const [currentSlug, setCurrentSlug] = React.useState(null)
          const [queue, setQueue] = React.useState(null)
          const [query, setQuery] = React.useState('')
          const [unreadOnly, setUnreadOnly] = React.useState(() => {
            try { return localStorage.getItem('dsh-reader-unread-only') === '1' } catch { return false }
          })
          const [selectorOpen, setSelectorOpen] = React.useState(true)
          const [selectorWidth, setSelectorWidth] = React.useState(
            () => clamp(readWidth(LS_SELECTOR_WIDTH) ?? 260, SELECTOR_MIN, SELECTOR_MAX),
          )
          const [dark, setDark] = React.useState(false)
          const [toast, setToast] = React.useState(null)
          const updatedAtRef = React.useRef(null)
          const rightRef = React.useRef(null)
          const currentPollSeqRef = React.useRef(0)
          const selectorWidthRef = React.useRef(selectorWidth)
          const toastTimerRef = React.useRef(null)
          selectorWidthRef.current = selectorWidth

          const showToast = React.useCallback((text) => {
            setToast(text)
            if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
            toastTimerRef.current = setTimeout(() => setToast(null), 2600)
          }, [])

          /* 挂载时若 sidebar 处于折叠态（窄栏），先展开 */
          React.useEffect(() => {
            if (props.collapsed === true && ctx.layout) {
              try { ctx.layout.toggleSidebar() } catch { /* 服务未接线时忽略 */ }
            }
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [])

          /* 主题：固定深色（2026-09-21 用户要求移除明/暗切换），不再跟随系统/服务 */
          React.useEffect(() => {
            setDark(true)
            return undefined
          }, [])

          /* 明/暗切换：优先写 DSH 全局偏好（面板/reader 随之同步），无服务时本地翻转 */
          const applyTheme = React.useCallback((next) => {
            const service = getService(ctx, 'theme')
            if (service !== undefined && service !== null && typeof service.setTheme === 'function') {
              try {
                service.setTheme(next)
                return
              } catch { /* 落到本地翻转 */ }
            }
            setDark(next === 'dark')
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [])

          /* 列宽 DOM 兜底（见文件头「列宽方案」注释） */
          React.useEffect(() => {
            const root = rootRef.current
            if (!root) return undefined
            let frame = root.parentElement
            while (frame && !frame.style.gridTemplateColumns) frame = frame.parentElement
            if (!frame) return undefined
            frameRef.current = frame
            const original = frame.style.gridTemplateColumns
            const applyWidth = () => {
              const viewport = frame.clientWidth || window.innerWidth
              const saved = readWidth(LS_SIDEBAR_WIDTH)
              const px = saved === null ? defaultSidebarWidth(viewport) : clampSidebarWidth(saved, viewport)
              frame.style.gridTemplateColumns = `${px}px minmax(0, 1fr) 0px`
            }
            applyWidth()
            window.addEventListener('resize', applyWidth)
            return () => {
              window.removeEventListener('resize', applyWidth)
              frameRef.current = null
              frame.style.gridTemplateColumns = original
            }
          }, [])

          /* 轮询 GET /current：用 updatedAt 判变，变了才换 iframe src（不每次重载） */
          const poll = React.useCallback(async () => {
            const requestSeq = ++currentPollSeqRef.current
            try {
              const res = await bridgeFetch('/current')
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const data = await res.json()
              if (requestSeq !== currentPollSeqRef.current) return
              setBridgeError(null)
              const hasPaper = data !== null && typeof data === 'object'
                && typeof data.left === 'string' && data.left.length > 0
              if (!hasPaper) {
                if (updatedAtRef.current !== null) {
                  updatedAtRef.current = null
                  rightRef.current = null
                  setCurrent(null)
                }
                return
              }
              const incomingUpdatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null
              const incomingRight = typeof data.right === 'string' && data.right.length > 0 ? data.right : null
              const knownUpdatedAt = updatedAtRef.current
              if ((incomingUpdatedAt !== knownUpdatedAt || incomingRight !== rightRef.current)
                && !(typeof incomingUpdatedAt === 'string' && typeof knownUpdatedAt === 'string' && incomingUpdatedAt < knownUpdatedAt)) {
                updatedAtRef.current = incomingUpdatedAt
                rightRef.current = incomingRight
                setCurrent({
                  left: data.left,
                  right: typeof data.right === 'string' && data.right.length > 0 ? data.right : undefined,
                  page: Number.isFinite(data.page) ? data.page : undefined,
                  title: typeof data.title === 'string' && data.title.length > 0 ? data.title : undefined,
                  paper_id: typeof data.paper_id === 'string' ? data.paper_id : undefined,
                  slug: typeof data.slug === 'string' ? data.slug : undefined,
                  canonicalCard: typeof data.canonicalCard === 'string' ? data.canonicalCard : undefined,
                  network: data.network !== null && typeof data.network === 'object' ? data.network : undefined,
                  obsidianUrl: typeof data.obsidianUrl === 'string' ? data.obsidianUrl : undefined,
                  networkViewUrl: typeof data.networkViewUrl === 'string' ? data.networkViewUrl : undefined,
                })
              }
            } catch {
              setBridgeError(`阅读桥未就绪（${BRIDGE} 不可达），请重启 DSH Desktop`)
            }
          }, [])

          /* 轮询 GET /papers：论文选择器数据源；失败静默保留旧列表 */
          const pollPapers = React.useCallback(async () => {
            try {
              const res = await bridgeFetch('/papers')
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const data = await res.json()
              setPapers(Array.isArray(data.papers) ? data.papers : [])
              const slug = data.current !== null && typeof data.current === 'object'
                && typeof data.current.slug === 'string' ? data.current.slug : null
              setCurrentSlug(slug)
              setQueue(data.queue !== null && typeof data.queue === 'object' ? data.queue : null)
            } catch { /* 桥不可达由 /current 轮询报错误条 */ }
          }, [])

          React.useEffect(() => {
            void poll()
            void pollPapers()
            const timer = setInterval(() => {
              void poll()
              void pollPapers()
            }, POLL_MS)
            return () => clearInterval(timer)
          }, [poll, pollPapers])

          const themeName = dark ? 'dark' : 'light'

          const src = React.useMemo(() => {
            if (current === null) return null
            return buildEmbeddedReaderUrl(BRIDGE, themeName)
          }, [current, themeName])

          /* 主题经 postMessage 同步给 reader.html（src 参数覆盖重载场景） */
          React.useEffect(() => {
            const frame = iframeRef.current
            if (frame === null || frame.contentWindow === null) return
            try {
              frame.contentWindow.postMessage(
                { source: 'dsh-reader-panel', type: 'theme', theme: themeName },
                BRIDGE,
              )
            } catch { /* iframe 尚未就绪时由 src 参数兜底 */ }
          }, [themeName, src])

          /* 收 iframe 的 selection / theme 消息（校验 origin 与 source） */
          React.useEffect(() => {
            const onMessage = (event) => {
              const frame = iframeRef.current
              if (event.origin !== BRIDGE || frame === null || event.source !== frame.contentWindow) return
              const data = event.data
              const selection = parseSelectionMessage(data)
              if (selection !== null) {
                const outcome = insertIntoComposer(ctx, buildQuoteText(selection))
                if (outcome === 'composer') showToast('已注入会话输入框')
                else if (outcome === 'clipboard') showToast('已复制到剪贴板，粘贴到输入框即可')
                else showToast('注入失败：会话输入框与剪贴板均不可用')
                return
              }
              const theme = parseThemeMessage(data)
              if (theme !== null) applyTheme(theme)
            }
            window.addEventListener('message', onMessage)
            return () => window.removeEventListener('message', onMessage)
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [applyTheme, showToast])

          const openWindow = React.useCallback(async () => {
            if (current === null) return
            try {
              const res = await bridgeFetch('/open', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  left: current.left,
                  ...(current.right === undefined ? {} : { right: current.right }),
                  ...(current.page === undefined ? {} : { page: current.page }),
                  ...(current.title === undefined ? {} : { title: current.title }),
                  ...(current.paper_id === undefined ? {} : { paper_id: current.paper_id }),
                  ...(current.slug === undefined ? {} : { slug: current.slug }),
                  ...(current.canonicalCard === undefined ? {} : { canonicalCard: current.canonicalCard }),
                  target: 'window',
                }),
              })
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
            } catch {
              setBridgeError('无法打开独立窗口：阅读桥不可达，请重启 DSH Desktop')
            }
          }, [current])

          /* 浏览论文：POST /select 换 current（只切换双栏，不动会话输入框）；
             inject=true 时才把提示词注入 composer（条目上的 ➤ 按钮 / 顶栏「注入会话」） */
          const selectPaper = React.useCallback(async (paper, inject = false) => {
            try {
              const res = await bridgeFetch('/select', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  ...(typeof paper.paper_id === 'string' ? { paper_id: paper.paper_id } : {}),
                  ...(typeof paper.slug === 'string' ? { slug: paper.slug } : {}),
                }),
              })
              const data = await res.json()
              if (!res.ok || data === null || typeof data !== 'object' || data.ok !== true) {
                const reason = data !== null && typeof data === 'object' && typeof data.error === 'string'
                  ? data.error : `HTTP ${res.status}`
                showToast(`选择失败：${reason}`)
                return
              }
              const next = typeof data.current === 'object' && data.current !== null ? data.current : {}
              if (inject) {
                const outcome = insertIntoComposer(ctx, buildPaperPrompt({
                  title: typeof next.title === 'string' ? next.title : paper.title,
                  pdfEn: typeof next.left === 'string' ? next.left : undefined,
                  pdfZh: typeof next.right === 'string' ? next.right : undefined,
                  card: typeof paper.card === 'string' ? paper.card : undefined,
                }))
                if (outcome === 'composer') showToast('已注入会话输入框')
                else if (outcome === 'clipboard') showToast('已复制到剪贴板，粘贴到输入框即可')
                else showToast('注入失败：会话输入框与剪贴板均不可用')
              }
              /* 立即换 iframe（updatedAt 对齐后轮询不会重载），并刷新列表高亮 */
              if (typeof next.left === 'string' && next.left.length > 0) {
                updatedAtRef.current = typeof next.updatedAt === 'string' ? next.updatedAt : null
                rightRef.current = typeof next.right === 'string' && next.right.length > 0 ? next.right : null
                setCurrent({
                  left: next.left,
                  right: typeof next.right === 'string' && next.right.length > 0 ? next.right : undefined,
                  page: Number.isFinite(next.page) ? next.page : undefined,
                  title: typeof next.title === 'string' && next.title.length > 0 ? next.title : undefined,
                  paper_id: typeof next.paper_id === 'string' ? next.paper_id : undefined,
                  slug: typeof next.slug === 'string' ? next.slug : undefined,
                  canonicalCard: typeof next.canonicalCard === 'string' ? next.canonicalCard : undefined,
                  network: next.network !== null && typeof next.network === 'object' ? next.network : undefined,
                  obsidianUrl: typeof next.obsidianUrl === 'string' ? next.obsidianUrl : undefined,
                  networkViewUrl: typeof next.networkViewUrl === 'string' ? next.networkViewUrl : undefined,
                })
              }
              setCurrentSlug(typeof paper.slug === 'string' ? paper.slug : null)
              void pollPapers()
            } catch {
              showToast('阅读桥不可达，请重启 DSH Desktop')
            }
          }, [showToast, pollPapers])

          /* 拖拽手柄公共逻辑：拖动期间禁 user-select、iframe 不吃指针事件 */
          const beginDrag = React.useCallback((event, measure, apply, commit) => {
            if (event.button !== 0) return
            event.preventDefault()
            const startX = event.clientX
            const startWidth = measure()
            let last = startWidth
            const iframe = iframeRef.current
            const prevSelect = document.body.style.userSelect
            const prevEvents = iframe === null ? '' : iframe.style.pointerEvents
            document.body.style.userSelect = 'none'
            if (iframe !== null) iframe.style.pointerEvents = 'none'
            const onMove = (move) => {
              last = apply(startWidth, startX, move.clientX)
            }
            const onUp = () => {
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
              document.body.style.userSelect = prevSelect
              if (iframe !== null) iframe.style.pointerEvents = prevEvents
              commit(last)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }, [])

          const onSelectorDrag = React.useCallback((event) => {
            beginDrag(
              event,
              () => selectorWidthRef.current,
              (startWidth, startX, clientX) => {
                const next = dragWidth(startWidth, startX, clientX, SELECTOR_MIN, SELECTOR_MAX)
                setSelectorWidth(next)
                return next
              },
              (final) => writeWidth(LS_SELECTOR_WIDTH, final),
            )
          }, [beginDrag])

          const onSidebarDrag = React.useCallback((event) => {
            beginDrag(
              event,
              () => {
                const root = rootRef.current
                return root === null ? defaultSidebarWidth(window.innerWidth) : root.getBoundingClientRect().width
              },
              (startWidth, startX, clientX) => {
                const frame = frameRef.current
                if (frame === null) return startWidth
                const viewport = frame.clientWidth || window.innerWidth
                const next = dragWidth(startWidth, startX, clientX, SIDEBAR_MIN,
                  Math.max(SIDEBAR_MIN, Math.round(viewport * SIDEBAR_RATIO_MAX)))
                frame.style.gridTemplateColumns = `${next}px minmax(0, 1fr) 0px`
                return next
              },
              (final) => writeWidth(LS_SIDEBAR_WIDTH, final),
            )
          }, [beginDrag])

          const P = dark ? PALETTES.dark : PALETTES.light
          const st = React.useMemo(() => makeStyles(P), [dark]) // eslint-disable-line react-hooks/exhaustive-deps

          const visiblePapers = React.useMemo(
            () => sortByScore(filterPapers(papers, query))
              .filter((paper) => !unreadOnly || paper.read !== true),
            [papers, query, unreadOnly],
          )

          /* 折叠窄栏态：只留一个展开按钮 */
          if (props.collapsed === true) {
            return h('div', { ref: rootRef, style: st.rail },
              h('button', {
                style: { ...st.btn, writingMode: 'vertical-lr' },
                title: '展开阅读器',
                onClick: () => { try { ctx.layout && ctx.layout.toggleSidebar() } catch { /* ignore */ } },
              }, '阅读器'))
          }

          const queueText = formatQueue(queue)

          const selectorColumn = selectorOpen
            ? h('div', { style: { ...st.selector, width: selectorWidth } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 } },
                h('input', {
                  style: { ...st.search, marginBottom: 0 },
                  value: query,
                  placeholder: '搜索 slug / 标题…',
                  onChange: (event) => setQuery(event.target.value),
                }),
                h('label', {
                  style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: P.dim, whiteSpace: 'nowrap', cursor: 'pointer' },
                  title: '只显示未读论文',
                },
                h('input', {
                  type: 'checkbox',
                  checked: unreadOnly,
                  onChange: (event) => {
                    setUnreadOnly(event.target.checked)
                    try { localStorage.setItem('dsh-reader-unread-only', event.target.checked ? '1' : '0') } catch { /* ignore */ }
                  },
                }),
                '未读')),
              h('div', { style: st.list },
                visiblePapers.length === 0
                  ? h('div', { style: { padding: '12px 8px', color: P.dim, fontSize: 12 } },
                    query.trim() === '' ? '论文列表为空' : '无匹配论文')
                  : visiblePapers.map((paper) => {
                    const isCurrent = paper.slug !== undefined && paper.slug === currentSlug
                    const read = paper.read === true
                    /* 整行 = 主按钮（浏览换篇，不动输入框） + ➤（换篇并注入会话） */
                    return h('div', {
                      key: typeof paper.slug === 'string' ? paper.slug : paper.title,
                      style: { display: 'flex', alignItems: 'stretch', gap: 2, marginBottom: 2 },
                    },
                    h('button', {
                      style: {
                        display: 'block',
                        flex: '1 1 auto',
                        minWidth: 0,
                        textAlign: 'left',
                        fontFamily: FONT,
                        fontSize: 12,
                        color: read ? P.dim : P.text,
                        background: isCurrent ? P.currentBg : 'transparent',
                        border: 'none',
                        borderLeft: isCurrent ? `3px solid ${P.accent}` : '3px solid transparent',
                        borderRadius: 4,
                        padding: '6px 8px',
                        cursor: 'pointer',
                      },
                      title: `${typeof paper.title === 'string' ? paper.title : paper.slug}\n点击浏览（不注入会话）`,
                      onClick: () => { void selectPaper(paper) },
                    },
                    h('div', {
                      style: {
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 6,
                      },
                    },
                    h('span', {
                      style: {
                        flex: '1 1 auto',
                        minWidth: 0,
                        fontWeight: read ? 400 : 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      },
                    }, typeof paper.title === 'string' && paper.title.length > 0 ? paper.title : paper.slug),
                    h('span', { style: { flex: '0 0 auto', color: P.dim, fontSize: 11 } },
                      formatScore(paper.score))),
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 2, fontSize: 11, color: P.dim } },
                      paper.hasZh === false && h('span', { title: '无中文镜像' }, '无镜像'),
                      read && h('span', null, '已读'))),
                    h('button', {
                      style: {
                        flex: '0 0 auto',
                        fontFamily: FONT,
                        fontSize: 12,
                        color: P.accent,
                        background: 'transparent',
                        border: 'none',
                        borderRadius: 4,
                        padding: '0 6px',
                        cursor: 'pointer',
                      },
                      title: '开始读这篇：换篇并把提示词注入会话输入框',
                      onClick: () => { void selectPaper(paper, true) },
                    }, '➤'))
                  })),
              h('div', { style: st.queueBar },
                queueText !== null ? `队列 ${queueText}` : `共 ${papers.length} 篇`))
            : h('div', { style: st.strip },
              h('button', {
                style: { ...st.btn, writingMode: 'vertical-lr', padding: '8px 2px' },
                title: '展开论文选择器',
                onClick: () => setSelectorOpen(true),
              }, '论文'))

          return h('div', { ref: rootRef, style: st.root },
            /* 顶栏：选择器开合 + 标题 + 提示标签 + 明/暗 + 导航 + 独立窗口 */
            h('div', { style: st.topbar },
              h('button', {
                style: st.btn,
                onClick: () => setSelectorOpen((v) => !v),
                title: selectorOpen ? '收起论文选择器' : '展开论文选择器',
              }, selectorOpen ? '收起论文' : '论文'),
              h('div', { style: st.title, title: current?.title ?? '' },
                current?.title ?? 'DSH 阅读器'),
              h('span', { style: st.hint }, '选中 PDF 文字可发送到会话'),
              h('button', {
                style: { ...st.btn, ...(current === null ? { opacity: 0.45, cursor: 'default' } : {}) },
                onClick: () => {
                  const slug = currentSlug
                  const paper = slug === null ? null : papers.find((p) => p.slug === slug)
                  if (paper !== null && paper !== undefined) void selectPaper(paper, true)
                },
                title: '把当前论文的提示词注入会话输入框（不发送）',
              }, '注入会话'),
              h('button', {
                style: st.btn,
                onClick: () => setNavOpen((v) => !v),
                title: '工作区导航',
              }, navOpen ? '收起导航' : '导航'),
              h('button', {
                style: { ...st.btn, ...(current === null ? { opacity: 0.45, cursor: 'default' } : {}) },
                onClick: () => { void openWindow() },
                title: '在独立窗口中打开当前论文',
              }, '独立窗口')),

            /* 可折叠「导航」区：渲染原生子槽 outlet，保留工作区导航 */
            navOpen && h('div', { style: st.nav },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6 } },
                renderSlot('sidebar.brand.mark', { size: 20 }, { fallback: null }),
                renderSlot('sidebar.brand.name', {}, { fallback: null })),
              renderSlot('sidebar.workspaces', { wide: true }, { fallback: null }),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6 } },
                renderSlot('sidebar.footer.action', { wide: true }, { fallback: null }),
                renderSlot('sidebar.settings', { wide: true }, { fallback: null }))),

            /* 桥不可达错误条（可重试） */
            bridgeError !== null && h('div', { style: st.errorBar },
              h('span', { style: { flex: '1 1 auto' } }, bridgeError),
              h('button', { style: st.btn, onClick: () => { void poll() } }, '重试')),

            /* 主体行：论文选择器 | 选择器手柄 | 阅读区 | 列宽手柄 */
            h('div', { style: st.body },
              selectorColumn,
              selectorOpen && h('div', {
                style: st.handle,
                title: '拖动调整选择器宽度',
                onMouseDown: onSelectorDrag,
              }),
              h('div', { style: st.reader },
                src !== null
                  ? h('iframe', {
                    key: src,
                    ref: iframeRef,
                    src,
                    style: { flex: '1 1 auto', border: 'none', background: P.iframeBg },
                    title: current?.title ?? '论文阅读器',
                  })
                  : h('div', { style: st.empty },
                    h('div', null,
                      '还没有打开的论文。',
                      h('br'),
                      '在左侧选择一篇论文，或在对话中让我打开一篇'))),
              h('div', {
                style: st.handle,
                title: '拖动调整阅读器列宽',
                onMouseDown: onSidebarDrag,
              })),

            toast !== null && h('div', { style: st.toast }, toast))
        }
      }

      const inject = ['slots', 'layout']
      function apply(ctx) {
        ctx.slots.inject('sidebar', function* () {
          yield ctx.slots.register(
            {
              name: 'sidebar',
              priority: -10,
              // 故意不声明 children：原生子槽声明归原生 sidebar 条目所有，
              // 重复声明会抛 "already declared"（见文件头注释）。
            },
            createReaderPanel(ctx),
          )
        })
      }

      exports.apply = apply
      exports.inject = inject
      return module.exports
    },
  })
}
