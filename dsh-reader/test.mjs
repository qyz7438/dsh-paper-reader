/**
 * dsh-reader verification harness. Runs without Electron:
 *   - a mock reader bridge on a random free 127.0.0.1 port records POST /open and
 *     POST /read payloads and serves GET /current;
 *   - a temporary papers.json (three fake papers, one read:true) and a
 *     temporary reader-queue.json feed the index and the reading queue;
 *   - reader_open is exercised through rank / query / ambiguous / bridge-down;
 *   - reader_save_thinking is exercised with a nonexistent pythonCmd;
 *   - reader_status / reader_next / reader_skip are exercised against a fake
 *     append script (node itself standing in for python) covering queue
 *     initialization, archive-on-next (writeback + read-mark + skip-read),
 *     end_of_queue, and skip-without-writeback;
 *   - when a real python exists, the real append_thinking.py is launched with
 *     a deliberately unmatchable query (script exits 1 with 未找到匹配卡片,
 *     writing nothing to any real card).
 *
 * Usage: node test.mjs
 */
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import plugin, { buildBridgeStartupInvocation, loadPaperGraph, startBridgeInBackground, windowsPowerShellPath } from './index.js'
import './client.js'

const execFileAsync = promisify(execFile)

/* The real reader bridge may be serving 58812 (parallel work / a running DSH
   Desktop); the mock bridge picks any free port so the suite never fights it
   (nor Windows' reserved port ranges). */
const BRIDGE_PORT = 0
const results = []
let failed = 0

function check(label, condition, detail = '') {
  results.push(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -- ${detail}`}`)
  if (!condition) failed += 1
}

/** Mount the plugin against a fake cordis context; returns the tool map. */
function mount(config) {
  const tools = new Map()
  const ctx = { tools: { register: (def) => tools.set(def.name, def) } }
  plugin.apply(ctx, config)
  return tools
}

const fakePapers = [
  {
    paper_id: 'paper:attention',
    slug: 'attention-is-all-you-need',
    title: 'Attention Is All You Need',
    score: 95.2,
    read: false,
    pdfEn: 'E:/fake/attention.en.pdf',
    pdfZh: 'E:/fake/attention.zh.pdf',
  },
  {
    paper_id: 'paper:robustness',
    slug: 'attention-robustness',
    title: 'Attention Robustness in Transformers',
    score: 88.1,
    read: false,
    pdfEn: 'E:/fake/robustness.en.pdf',
  },
  {
    paper_id: 'paper:grokking',
    slug: 'grokking-paper',
    title: 'Grokking Beyond Euclidean Data',
    score: 90.5,
    read: false,
    pdfEn: 'E:/fake/grokking.en.pdf',
    pdfZh: 'E:/fake/grokking.zh.pdf',
  },
]

/* ------------------------------- mock bridge ---------------------------- */

const bridgeRequests = []
const readRequests = []
let bridgeCurrent = {}
const liveReadState = {}
let rejectOpen = false
let rejectAdvance = false
let interleaveSelectionOnAdvance = false
let revisionCounter = 0
const advanceRequests = []
let bridgeRequestsAuthenticated = true

function readBody(req) {
  return new Promise((resolveBody) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => resolveBody(body))
  })
}

function queueOrderHash(order) {
  return createHash('sha256').update(JSON.stringify(order)).digest('hex')
}

function ensureBridgeRevision() {
  if (typeof bridgeCurrent.revision !== 'string') bridgeCurrent = { ...bridgeCurrent, revision: `r-${++revisionCounter}` }
  return bridgeCurrent.revision
}

function requestAuthenticated(req) {
  bridgeRequestsAuthenticated &&= typeof req.headers['x-dsh-reader-token'] === 'string' && req.headers['x-dsh-reader-token'].length > 0
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname === '/open') {
    requestAuthenticated(req)
    const payload = JSON.parse(await readBody(req))
    bridgeRequests.push(payload)
    if (rejectOpen) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'open_rejected' }))
      return
    }
    bridgeCurrent = { ...payload, revision: `r-${++revisionCounter}`, updatedAt: new Date().toISOString() }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ opened: true }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/validate-current') {
    requestAuthenticated(req)
    const payload = JSON.parse(await readBody(req))
    const expected = payload?.expected
    const queue = JSON.parse(await readFile(queuePath, 'utf8'))
    const valid = typeof expected?.currentRevision === 'string'
      && expected.currentRevision === ensureBridgeRevision()
      && expected.queuePointer === queue.pointer
      && expected.queueOrderHash === queueOrderHash(queue.order)
    res.writeHead(valid ? 200 : 409, { 'content-type': 'application/json' })
    res.end(JSON.stringify(valid ? { ok: true, receipt: 'validated' } : { ok: false, error: 'current_or_queue_conflict' }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/advance') {
    requestAuthenticated(req)
    const payload = JSON.parse(await readBody(req))
    advanceRequests.push(payload)
    if (interleaveSelectionOnAdvance) {
      interleaveSelectionOnAdvance = false
      bridgeCurrent = {
        left: 'E:/fake/robustness.en.pdf', title: 'Attention Robustness in Transformers',
        paper_id: 'paper:robustness', slug: 'attention-robustness',
        revision: `r-${++revisionCounter}`, updatedAt: new Date().toISOString(),
      }
    }
    const expected = payload?.expected
    const queue = JSON.parse(await readFile(queuePath, 'utf8'))
    const valid = !rejectAdvance && typeof expected?.currentRevision === 'string'
      && expected.currentRevision === ensureBridgeRevision()
      && expected.queuePointer === queue.pointer
      && expected.queueOrderHash === queueOrderHash(queue.order)
    if (!valid) {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'current_or_queue_conflict' }))
      return
    }
    await writeFile(queuePath, JSON.stringify({ pointer: payload.nextPointer, order: queue.order }), 'utf8')
    bridgeCurrent = { ...payload.next, revision: `r-${++revisionCounter}`, updatedAt: new Date().toISOString() }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, current: bridgeCurrent, queue: { pointer: payload.nextPointer } }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/read') {
    const payload = JSON.parse(await readBody(req))
    readRequests.push(payload)
    liveReadState[payload.path] = payload.read
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...payload }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/current') {
    if (Object.keys(bridgeCurrent).length > 0) ensureBridgeRevision()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(bridgeCurrent))
    return
  }
  if (req.method === 'GET' && url.pathname === '/read-state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(liveReadState))
    return
  }
  res.writeHead(404)
  res.end('not found')
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(BRIDGE_PORT, '127.0.0.1', resolve)
})
const bridgePort = server.address().port

const tempDir = await mkdtemp(join(tmpdir(), 'dsh-reader-test-'))
const bridgeTokenPath = join(tempDir, 'reader-bridge-session.token')
await writeFile(bridgeTokenPath, 'test-bridge-session-token\n', 'utf8')
const papersPath = join(tempDir, 'papers.json')
await writeFile(papersPath, JSON.stringify(fakePapers), 'utf8')
const queuePath = join(tempDir, 'reader-queue.json')
const graphPath = join(tempDir, 'graph.json')
await writeFile(graphPath, JSON.stringify({
  schema_version: 'paper-network-v1',
  nodes: [
    { id: 'concept:attention', type: 'concept', label: 'Attention', card: '_wiki/concepts/attention.md' },
    { id: 'task:reasoning', type: 'task', label: 'Reasoning', card: '_wiki/tasks/reasoning.md' },
    { id: 'paper:attention', type: 'paper', label: 'Attention Is All You Need', card: '_wiki/references/papers/attention.md', metadata: { paper_id: 'paper:attention', reader_slugs: ['attention-is-all-you-need'], pdf_en: 'E:/fake/attention.en.pdf', pdf_zh: 'E:/fake/attention.zh.pdf', concept_ids: ['concept:attention'], task_ids: ['task:reasoning'], method_ids: [] } },
    { id: 'paper:robustness', type: 'paper', label: 'Attention Robustness in Transformers', card: '_wiki/references/papers/robustness.md', metadata: { paper_id: 'paper:robustness', reader_slugs: ['attention-robustness'], pdf_en: 'E:/fake/robustness.en.pdf', concept_ids: ['concept:attention'], task_ids: ['task:reasoning'], method_ids: [] } },
    { id: 'paper:grokking', type: 'paper', label: 'Grokking Beyond Euclidean Data', card: '_wiki/references/papers/grokking.md', metadata: { paper_id: 'paper:grokking', reader_slugs: ['grokking-paper'], pdf_en: 'E:/fake/grokking.en.pdf', pdf_zh: 'E:/fake/grokking.zh.pdf', concept_ids: [], task_ids: ['task:reasoning'], method_ids: [] } },
  ],
}), 'utf8')
const nestedGraphPath = join(tempDir, '_wiki', 'network', 'graph.json')
await mkdir(join(tempDir, '_wiki', 'network'), { recursive: true })
await writeFile(nestedGraphPath, JSON.stringify({
  schema_version: 'paper-network-v1',
  nodes: [{
    id: 'paper:relative-loader', type: 'paper', label: 'Relative loader', card: '_wiki/references/relative-loader.md',
    metadata: { paper_id: 'paper:relative-loader', reader_slugs: ['relative-loader'], pdf_en: ['pdfs/relative-loader.pdf'] },
  }],
}), 'utf8')
const nestedGraph = await loadPaperGraph(nestedGraphPath)
check(
  'host graph loader derives vault root from _wiki/network/graph.json',
  nestedGraph.paperById('paper:relative-loader')?.pdfEn === join(tempDir, 'pdfs', 'relative-loader.pdf'),
)
const translationPapersPath = join(tempDir, 'translation-papers.json')
const translationGraphPath = join(tempDir, 'translation-graph.json')
const translationQueuePath = join(tempDir, 'translation-queue.json')
await writeFile(translationPapersPath, JSON.stringify([
  { paper_id: 'paper:translation-only', slug: 'translation-only', title: 'Translation only', pdfEn: 'E:/fake/translation-only_镜像.pdf' },
]), 'utf8')
await writeFile(translationGraphPath, JSON.stringify({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:translation-only', type: 'paper', label: 'Translation only', card: '_wiki/references/translation-only.md',
    metadata: { paper_id: 'paper:translation-only', reader_slugs: ['translation-only'], pdf_en: [], pdf_zh: ['E:/fake/translation-only_镜像.pdf'],
      assets: [{ path: 'pdfs/translation-only_镜像.pdf', raw_path: 'E:/fake/translation-only_镜像.pdf', role: 'translation' }] },
  }],
}), 'utf8')
await writeFile(translationQueuePath, JSON.stringify({ pointer: 0, order: ['paper:translation-only'] }), 'utf8')

/* Fake append_thinking.py: a node script (pythonCmd = process.execPath) that
   records every invocation as one JSON line so reader_next's archive step can
   be asserted without touching a real card. */
const appendLogPath = join(tempDir, 'append-log.jsonl')
const fakeAppendPath = join(tempDir, 'fake-append.mjs')
await writeFile(fakeAppendPath, `import { appendFileSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(appendLogPath)}, JSON.stringify({ argv: process.argv.slice(2), text: input }) + '\\n')
})
`, 'utf8')

/** Read every recorded fake-append invocation. */
async function appendLog() {
  try {
    const text = await readFile(appendLogPath, 'utf8')
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const baseConfig = {
  bridgeUrl: `http://127.0.0.1:${bridgePort}`,
  bridgeTokenPath,
  bridgeStartScript: '', // never launch a real bridge from this isolated harness
  papersPath,
  queuePath,
  graphPath,
  pythonCmd: 'dsh-reader-definitely-not-a-python-xyz',
  appendScript: 'E:/CLI/llm-wiki/scripts/append_thinking.py',
}

/** Config whose "python" is node itself running the fake append script. */
const queueConfig = {
  ...baseConfig,
  pythonCmd: process.execPath,
  appendScript: fakeAppendPath,
}

try {
  /* --------------------------- Config validation ------------------------- */
  const configResult = plugin.Config['~standard'].validate({})
  check('Config 为空对象时应用默认值', configResult.issues === undefined && configResult.value.bridgeUrl === 'http://127.0.0.1:58812')
  const badConfig = plugin.Config['~standard'].validate({ bridgeUrl: 42 })
  const startup = buildBridgeStartupInvocation({ bridgeStartScript: 'E:/fixture/start-reader-bridge.ps1' }, 'C:/Windows')
  check('apply startup hook uses absolute hidden non-secret PowerShell invocation', startup?.command === windowsPowerShellPath('C:/Windows')
    && startup.args.includes('-WindowStyle') && startup.args.includes('Hidden')
    && startup.args.at(-1) === 'E:/fixture/start-reader-bridge.ps1'
    && !startup.args.some((item) => item.includes('token')))
  const startupEvents = []
  const startupHandlers = new Map()
  let startupUnref = false
  let startupSpawn = null
  startBridgeInBackground(
    { bridgeStartScript: 'E:/fixture/start-reader-bridge.ps1' },
    {
      platform: 'win32',
      systemRoot: 'C:/Windows',
      spawn: (command, args, options) => {
        startupSpawn = { command, args, options }
        return {
          pid: 4242,
          on: (event, listener) => { startupHandlers.set(event, listener) },
          unref: () => { startupUnref = true },
        }
      },
      logger: { info: (line) => startupEvents.push(line) },
    },
  )
  startupHandlers.get('error')?.({ code: 'ENOENT', message: 'never logged' })
  startupHandlers.get('exit')?.(17)
  check(
    'startup helper spawn uses absolute command, attached hidden ignore, and fixed diagnostics',
    startupSpawn?.command === windowsPowerShellPath('C:/Windows')
      && startupSpawn.args.at(-1) === 'E:/fixture/start-reader-bridge.ps1'
      && startupSpawn.options.detached === false && startupSpawn.options.stdio === 'ignore' && startupSpawn.options.windowsHide === true
      && startupUnref === true
      && JSON.stringify(startupEvents) === JSON.stringify([
        '[dsh-reader] bridge_start_attempt',
        '[dsh-reader] bridge_start_child_pid 4242',
        '[dsh-reader] bridge_start_spawn_error ENOENT',
        '[dsh-reader] bridge_start_helper_exit 17',
      ]),
    JSON.stringify({ startupSpawn, startupEvents }),
  )
  check('Config 拒绝非字符串 bridgeUrl', Array.isArray(badConfig.issues) && badConfig.issues.length > 0)

  /* ------------------------------ reader_open ---------------------------- */
  const tools = mount(baseConfig)
  check(
    '注册了五个工具',
    tools.has('reader_open') && tools.has('reader_save_thinking')
      && tools.has('reader_next') && tools.has('reader_skip') && tools.has('reader_status'),
  )
  const openTool = tools.get('reader_open')
  const saveTool = tools.get('reader_save_thinking')

  // 1. rank path (1-based), with page, both PDFs present
  const byRank = await openTool.execute({ rank: 2, page: 3 }, { signal: undefined })
  check('rank 路径打开第 2 篇', byRank.ok === true && byRank.title === 'Attention Robustness in Transformers' && byRank.rank === 2)
  const rankReq = bridgeRequests.at(-1)
  check(
    'rank 请求体正确（无 pdfZh 时省略 right，携带 page）',
    rankReq?.left === 'E:/fake/robustness.en.pdf' && rankReq?.right === undefined && rankReq?.page === 3
      && rankReq?.title === 'Attention Robustness in Transformers' && bridgeRequestsAuthenticated,
    JSON.stringify(rankReq),
  )

  // 2. query unique match
  const byQuery = await openTool.execute({ query: 'robustness' }, { signal: undefined })
  check('query 唯一命中并打开', byQuery.ok === true && byQuery.slug === 'attention-robustness')
  const queryReq = bridgeRequests.at(-1)
  check('query 请求体正确', queryReq?.left === 'E:/fake/robustness.en.pdf' && queryReq?.page === undefined, JSON.stringify(queryReq))

  // 2b. query match with both PDFs sends right
  const byQueryZh = await openTool.execute({ query: 'all you need' }, { signal: undefined })
  check('query 命中含译文论文时携带 right', byQueryZh.ok === true && bridgeRequests.at(-1)?.right === 'E:/fake/attention.zh.pdf')

  // 3. ambiguous query: returns candidates, opens nothing
  const before = bridgeRequests.length
  const ambiguous = await openTool.execute({ query: 'attention' }, { signal: undefined })
  check(
    '多候选返回候选列表且不打开',
    ambiguous.ok === false && ambiguous.error === 'ambiguous' && ambiguous.candidates.length === 2
      && ambiguous.candidates[0].rank === 1 && bridgeRequests.length === before,
    JSON.stringify(ambiguous),
  )

  // 3b. out-of-range rank
  const outOfRange = await openTool.execute({ rank: 9 }, { signal: undefined })
  check('rank 越界报 rank_out_of_range', outOfRange.ok === false && outOfRange.error === 'rank_out_of_range')

  // 4. bridge unreachable
  const downTools = mount({ ...baseConfig, bridgeUrl: 'http://127.0.0.1:58813' })
  const bridgeDown = await downTools.get('reader_open').execute({ rank: 1 }, { signal: undefined })
  check(
    '桥不可达返回 bridge_unavailable 且提示重启',
    bridgeDown.ok === false && bridgeDown.error === 'bridge_unavailable'
      && bridgeDown.message === 'DSH 阅读桥未就绪，请重启 DSH Desktop',
    JSON.stringify(bridgeDown),
  )

  /* ------------------------- reader_save_thinking ------------------------ */

  // 5. python unavailable
  const noPython = await saveTool.execute({ query: 'grokking', text: '一些思考' }, { signal: undefined })
  check(
    'python 不可用返回 python_unavailable',
    noPython.ok === false && noPython.error === 'python_unavailable' && noPython.message.includes('dsh-reader-definitely-not-a-python-xyz'),
    JSON.stringify(noPython),
  )

  // 6. real python + real script, unmatchable query (must not write any card)
  let realPython = null
  for (const candidate of ['python', 'py']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10000 })
      realPython = candidate
      break
    } catch { /* try next */ }
  }
  if (realPython === null) {
    results.push('SKIP  真实 python 不可用，跳过真实脚本路径')
  } else {
    const realTools = mount({ ...baseConfig, pythonCmd: realPython })
    const real = await realTools.get('reader_save_thinking').execute(
      { query: 'dsh-reader-unmatchable-paper-zzz', text: '这条思考不应写入任何卡片' },
      { signal: undefined },
    )
    check(
      '真实脚本启动并如实报「未找到匹配卡片」（退出码 1，无写入）',
      real.ok === false && real.error === 'script_failed' && real.exitCode === 1,
      JSON.stringify(real),
    )
  }
  /* ------------- reader_status / reader_next / reader_skip --------------- */
  const queueTools = mount(queueConfig)

  // 7. fresh status: initializes reader-queue.json from index order
  const status0 = await queueTools.get('reader_status').execute({}, { signal: undefined })
  check(
    'reader_status 初始化队列并返回位置 0/3',
    status0.ok === true && status0.queue.pointer === 0 && status0.queue.total === 3,
    JSON.stringify(status0),
  )
  check(
    'reader_status 返回指针处论文（slug/title/score/read）',
    status0.paper?.slug === 'attention-is-all-you-need' && status0.paper?.score === 95.2 && status0.paper?.read === false,
  )
  const queueOnDisk = JSON.parse(await readFile(queuePath, 'utf8'))
  check(
    'reader-queue.json 已按索引顺序落盘',
    queueOnDisk.pointer === 0 && queueOnDisk.order.length === 3 && queueOnDisk.order[2] === 'grokking-paper',
    JSON.stringify(queueOnDisk),
  )
  check('reader_status 返回桥 current 与可用性', status0.bridgeAvailable === true && typeof status0.current === 'object')

  // A conflicting current identity must fail closed: no card append, read mark,
  // or queue rewrite is allowed when paper_id disagrees with slug/PDF.
  bridgeCurrent = {
    left: 'E:/fake/robustness.en.pdf',
    title: 'Attention Robustness in Transformers',
    paper_id: 'paper:attention',
    slug: 'attention-robustness',
    updatedAt: new Date().toISOString(),
  }
  const conflictQueue = await readFile(queuePath, 'utf8')
  const conflictLogs = (await appendLog()).length
  const conflictReads = readRequests.length
  const conflict = await queueTools.get('reader_next').execute({ summary: 'must not be written' }, { signal: undefined })
  check(
    'reader_next 身份冲突时不写卡、不标记、不推进',
    conflict.ok === false && conflict.error === 'current_unresolved'
      && (await appendLog()).length === conflictLogs && readRequests.length === conflictReads
      && (await readFile(queuePath, 'utf8')) === conflictQueue,
    JSON.stringify(conflict),
  )

  // 8. The visible current deliberately differs from the legacy queue pointer.
  // The summary must target this visible Beta card and retain queue order.
  bridgeCurrent = {
    left: 'E:/fake/robustness.en.pdf',
    title: 'Attention Robustness in Transformers',
    paper_id: 'paper:robustness',
    slug: 'attention-robustness',
    updatedAt: new Date().toISOString(),
  }
  const opensBefore = bridgeRequests.length
  const next1 = await queueTools.get('reader_next').execute(
    { summary: '注意力机制小结', question: 'QKV 怎么算？' },
    { signal: undefined },
  )
  check(
    'reader_next 回写后前进并跳过已读论文',
    next1.ok === true && next1.archived === true && next1.current?.slug === 'attention-robustness'
      && next1.next?.slug === 'grokking-paper' && next1.next?.rank === 3 && next1.next?.score === 90.5,
    JSON.stringify(next1),
  )
  const log1 = await appendLog()
  check(
    'reader_next 回写调用 append_thinking（query=当前 slug，source=DSH 阅读讨论，带 question）',
    log1.length === 1 && log1[0].argv[0] === 'attention-robustness'
      && log1[0].argv[log1[0].argv.indexOf('--source') + 1] === 'DSH 阅读讨论'
      && log1[0].argv[log1[0].argv.indexOf('--question') + 1] === 'QKV 怎么算？'
      && log1[0].text === '注意力机制小结',
    JSON.stringify(log1),
  )
  check(
    'reader_next 把当前 PDF 标记已读（POST /read）',
    readRequests.length === 1 && readRequests[0].path === 'E:/fake/robustness.en.pdf' && readRequests[0].read === true,
    JSON.stringify(readRequests),
  )
  check(
    'reader_next CAS advances and submits the bilingual next selection',
    advanceRequests.length >= 1 && advanceRequests.at(-1)?.next?.left === 'E:/fake/grokking.en.pdf'
      && advanceRequests.at(-1)?.next?.right === 'E:/fake/grokking.zh.pdf'
      && advanceRequests.at(-1)?.nextPointer === 2,
    JSON.stringify(advanceRequests.at(-1)),
  )
  const queueAfterNext = JSON.parse(await readFile(queuePath, 'utf8'))
  check('reader_next 持久化 pointer=2', queueAfterNext.pointer === 2, JSON.stringify(queueAfterNext))

  // 9. reader_next at the end: still archives the current paper, then reports end_of_queue
  const next2 = await queueTools.get('reader_next').execute({ summary: '最后一篇小结' }, { signal: undefined })
  check(
    'reader_next 到末尾返回 end_of_queue（仍完成回写）',
    next2.ok === false && next2.error === 'end_of_queue' && next2.archived === true && next2.current?.slug === 'grokking-paper',
    JSON.stringify(next2),
  )
  const log2 = await appendLog()
  check('末尾回写仍调用 append_thinking', log2.length === 2 && log2[1].argv[0] === 'grokking-paper', JSON.stringify(log2))
  check('末尾标记已读仍发出', readRequests.length === 2 && readRequests[1].path === 'E:/fake/grokking.en.pdf')

  // 10. reader_skip: no writeback, no read-mark, advances and opens next unread
  await rm(queuePath, { force: true })
  bridgeCurrent = {
    left: 'E:/fake/attention.en.pdf',
    title: 'Attention Is All You Need',
    paper_id: 'paper:attention',
    slug: 'attention-is-all-you-need',
    updatedAt: new Date().toISOString(),
  }
  delete liveReadState['E:/fake/grokking.en.pdf']
  const logBefore = (await appendLog()).length
  const readsBefore = readRequests.length
  const skip1 = await queueTools.get('reader_skip').execute({}, { signal: undefined })
  check(
    'reader_skip 跳过并打开下一篇未读',
    skip1.ok === true && skip1.current?.slug === 'attention-is-all-you-need' && skip1.next?.slug === 'grokking-paper',
    JSON.stringify(skip1),
  )
  check(
    'reader_skip 不回写也不标记已读',
    (await appendLog()).length === logBefore && readRequests.length === readsBefore,
  )

  // 11. reader_status reflects the advanced pointer and the bridge current
  const status1 = await queueTools.get('reader_status').execute({}, { signal: undefined })
  check(
    'reader_status 反映推进后的指针与桥 current',
    status1.ok === true && status1.queue.pointer === 2 && status1.paper?.slug === 'grokking-paper'
      && status1.current?.left === 'E:/fake/grokking.en.pdf',
    JSON.stringify(status1),
  )

  // 12. reader_skip at the end
  const skip2 = await queueTools.get('reader_skip').execute({}, { signal: undefined })
  check('reader_skip 到末尾返回 end_of_queue', skip2.ok === false && skip2.error === 'end_of_queue', JSON.stringify(skip2))

  // A rejected atomic advance must leave the retained pointer untouched.
  await rm(queuePath, { force: true })
  bridgeCurrent = {
    left: 'E:/fake/attention.en.pdf',
    right: 'E:/fake/attention.zh.pdf',
    title: 'Attention Is All You Need',
    paper_id: 'paper:attention',
    slug: 'attention-is-all-you-need',
    updatedAt: new Date().toISOString(),
  }
  delete liveReadState['E:/fake/attention.en.pdf']
  delete liveReadState['E:/fake/grokking.en.pdf']
  await queueTools.get('reader_status').execute({}, { signal: undefined })
  const queueBeforeAdvanceFailure = await readFile(queuePath, 'utf8')
  rejectAdvance = true
  const rejectedAdvance = await queueTools.get('reader_skip').execute({}, { signal: undefined })
  rejectAdvance = false
  check(
    'reader_skip rejected atomic advance leaves persisted pointer unchanged',
    rejectedAdvance.ok === false && rejectedAdvance.error === 'current_or_queue_conflict'
      && (await readFile(queuePath, 'utf8')) === queueBeforeAdvanceFailure,
    JSON.stringify(rejectedAdvance),
  )

  // A stale skip observes A; a panel selection changes to C before bridge CAS.
  // The stale request may not persist B's pointer or restore the old selection.
  const queueBeforeSelectionRace = await readFile(queuePath, 'utf8')
  bridgeCurrent = {
    left: 'E:/fake/attention.en.pdf', title: 'Attention Is All You Need',
    paper_id: 'paper:attention', slug: 'attention-is-all-you-need',
    revision: `r-${++revisionCounter}`, updatedAt: new Date().toISOString(),
  }
  interleaveSelectionOnAdvance = true
  const selectionRace = await queueTools.get('reader_skip').execute({}, { signal: undefined })
  check(
    'panel selection C conflicts with stale skip without queue write or restore',
    selectionRace.ok === false && selectionRace.error === 'current_or_queue_conflict'
      && (await readFile(queuePath, 'utf8')) === queueBeforeSelectionRace
      && bridgeCurrent.slug === 'attention-robustness',
    JSON.stringify({ selectionRace, bridgeCurrent }),
  )

  const translationTools = mount({ ...queueConfig, papersPath: translationPapersPath, graphPath: translationGraphPath, queuePath: translationQueuePath })
  bridgeCurrent = {
    paper_id: 'paper:translation-only', slug: 'translation-only', left: 'E:/fake/translation-only_镜像.pdf',
    revision: `r-${++revisionCounter}`, updatedAt: new Date().toISOString(),
  }
  const translationQueueBefore = await readFile(translationQueuePath, 'utf8')
  const translationAppendBefore = (await appendLog()).length
  const translationReadBefore = readRequests.length
  const translationAdvanceBefore = advanceRequests.length
  const translationNext = await translationTools.get('reader_next').execute({ summary: 'must not append' }, { signal: undefined })
  check(
    'reader_next translation-only item rejects before append/read/queue advance',
    translationNext.ok === false && translationNext.error === 'missing_original_asset'
      && (await appendLog()).length === translationAppendBefore && readRequests.length === translationReadBefore
      && advanceRequests.length === translationAdvanceBefore && (await readFile(translationQueuePath, 'utf8')) === translationQueueBefore,
    JSON.stringify(translationNext),
  )
} finally {
  server.close()
  await rm(tempDir, { recursive: true, force: true })
}

/* ------------- first-party dependency path (app node_modules) ----------- */
/* index.js prefers bare imports of @deepseek-ai/schemastery and            */
/* @deepseek-ai/dsh-tools. Those do not resolve from this directory, so the */
/* suite above exercises the zero-dependency fallbacks. Here the very same  */
/* call shapes are replayed against the real packages inside the packaged   */
/* app (imported by absolute file URL, which keeps their own resolution     */
/* root intact) to prove the first-party path works once the loader         */
/* resolves bare specifiers.                                                */
try {
  const { pathToFileURL } = await import('node:url')
  const appNm = 'E:/DSH1/DSH Desktop/resources/app/node_modules'
  const realZ = (await import(pathToFileURL(join(appNm, '@deepseek-ai/schemastery/lib/index.mjs')).href)).default
  const realDefineTool = (await import(pathToFileURL(join(appNm, '@deepseek-ai/dsh-tools/lib/index.js')).href)).defineTool

  const realConfig = realZ.object({
    bridgeUrl: realZ.string().default('http://127.0.0.1:58812'),
    papersPath: realZ.string().default('E:/DSH1/paper-reader/papers.json'),
    queuePath: realZ.string().default('E:/DSH1/paper-reader/reader-queue.json'),
    pythonCmd: realZ.string().default('python'),
    appendScript: realZ.string().default('E:/CLI/llm-wiki/scripts/append_thinking.py'),
  })
  const good = realConfig['~standard'].validate({})
  check('一方 schemastery：Config 应用默认值', good.issues === undefined && good.value.bridgeUrl === 'http://127.0.0.1:58812')
  const bad = realConfig['~standard'].validate({ bridgeUrl: 42 })
  check('一方 schemastery：Config 拒绝坏值', Array.isArray(bad.issues) && bad.issues.length > 0)

  const probe = realDefineTool({
    name: 'dsh_reader_probe',
    description: 'probe',
    parameters: { q: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    },
    execute: async () => ({ ok: true }),
  })
  const probeOk = await probe.execute({ q: 'x' }, { signal: undefined })
  let probeThrew = false
  try { await probe.execute({}, { signal: undefined }) } catch { probeThrew = true }
  check('一方 defineTool：合法参数执行通过、缺参抛错', probeOk.ok === true && probeThrew)
} catch (error) {
  results.push(`SKIP  一方依赖集成验证：${error instanceof Error ? error.message : String(error)}`)
}

/* ------------------ client.js 纯函数核（无浏览器依赖） ------------------ */
/* client.js 顶层在 window 缺失时跳过 loader 注册，纯函数经                */
/* globalThis.__DSH_READER_PANEL_CORE__ 暴露。                            */
const core = globalThis.__DSH_READER_PANEL_CORE__
check('client.js 纯函数核已暴露', core !== undefined && typeof core === 'object')
if (core !== undefined) {
  const list = [
    { slug: 'alpha-paper', title: 'Alpha Folding', score: 91.5, read: false, hasZh: true },
    { slug: 'beta-paper', title: 'Beta Waves', score: 88, read: true, hasZh: false },
    { slug: 'gamma', title: 'GAMMA Rays', read: false, hasZh: true },
  ]

  // filterPapers
  check('filterPapers 空查询返回全部', core.filterPapers(list, '  ').length === 3)
  check('filterPapers 大小写不敏感匹配 title', core.filterPapers(list, 'gamma').length === 1)
  check('filterPapers 匹配 slug 子串', core.filterPapers(list, 'BETA-paper').length === 1)
  check('filterPapers 无命中返回空', core.filterPapers(list, 'zzz-none').length === 0)

  // sortByScore：降序、缺分最后、不改原数组
  const sorted = core.sortByScore(list)
  check(
    'sortByScore 降序且缺分排最后',
    sorted[0].slug === 'alpha-paper' && sorted[1].slug === 'beta-paper' && sorted[2].slug === 'gamma'
      && list[0].slug === 'alpha-paper',
  )

  // 拖拽数学
  check('dragWidth 正向位移', core.dragWidth(260, 100, 160, 180, 420) === 320)
  check('dragWidth 钳制下限', core.dragWidth(260, 100, -500, 180, 420) === 180)
  check('dragWidth 钳制上限', core.dragWidth(260, 100, 900, 180, 420) === 420)
  check('clampSidebarWidth 钳制 260–75% 视口',
    core.clampSidebarWidth(100, 1000) === 260 && core.clampSidebarWidth(900, 1000) === 750
      && core.clampSidebarWidth(500, 1000) === 500)
  check('defaultSidebarWidth 取约 62% 视口并保会话列 480px',
    core.defaultSidebarWidth(1600) === 992 && core.defaultSidebarWidth(900) === 558 - 138)

  // buildPaperPrompt 契约文本
  const prompt = core.buildPaperPrompt({ title: 'T', pdfEn: 'E:/a.en.pdf', pdfZh: 'E:/a.zh.pdf', card: 'E:/a.md' })
  check(
    'buildPaperPrompt 四行契约格式',
    prompt === '读论文《T》\n- 原文: E:/a.en.pdf\n- 镜像: E:/a.zh.pdf\n- 卡片: E:/a.md\n先给我三段式导读，再陪我逐节读。',
    JSON.stringify(prompt),
  )
  check(
    'buildPaperPrompt 缺镜像/卡片写「无」',
    core.buildPaperPrompt({ title: 'T', pdfEn: 'E:/a.en.pdf' })
      === '读论文《T》\n- 原文: E:/a.en.pdf\n- 镜像: 无\n- 卡片: 无\n先给我三段式导读，再陪我逐节读。',
  )

  // buildQuoteText 引用块格式
  check(
    'buildQuoteText 引用块格式',
    core.buildQuoteText({ title: 'T', page: 7, text: ' hello ' }) === '【《T》p.7】\n> hello\n',
  )
  check('buildQuoteText 缺页码用 ?', core.buildQuoteText({ title: 'T', text: 'x' }) === '【《T》p.?】\n> x\n')

  // parseSelectionMessage 校验
  check(
    'parseSelectionMessage 合法消息通过',
    (() => {
      const parsed = core.parseSelectionMessage({ source: 'dsh-reader', type: 'selection', text: 'abc', page: 3, title: 'T' })
      return parsed !== null && parsed.text === 'abc' && parsed.page === 3 && parsed.title === 'T'
    })(),
  )
  check('parseSelectionMessage 拒绝错误 source', core.parseSelectionMessage({ source: 'evil', type: 'selection', text: 'x' }) === null)
  check('parseSelectionMessage 拒绝非 selection 类型', core.parseSelectionMessage({ source: 'dsh-reader', type: 'theme', theme: 'dark' }) === null)
  check('parseSelectionMessage 拒绝空文本', core.parseSelectionMessage({ source: 'dsh-reader', type: 'selection', text: '  ' }) === null)
  check('parseSelectionMessage 拒绝非对象', core.parseSelectionMessage('selection') === null && core.parseSelectionMessage(null) === null)

  // parseThemeMessage 校验
  check('parseThemeMessage 只认 dark/light',
    core.parseThemeMessage({ source: 'dsh-reader', type: 'theme', theme: 'dark' }) === 'dark'
      && core.parseThemeMessage({ source: 'dsh-reader', type: 'theme', theme: 'sepia' }) === null
      && core.parseThemeMessage({ source: 'evil', type: 'theme', theme: 'light' }) === null)

  // resolveThemeName
  check('resolveThemeName 读 active.colorScheme',
    core.resolveThemeName({ active: { colorScheme: 'dark' } }) === 'dark'
      && core.resolveThemeName({ active: { colorScheme: 'light' } }) === 'light'
      && core.resolveThemeName({}) === null && core.resolveThemeName(null) === null)

  // mergeDraft 追加逻辑
  check('mergeDraft 空草稿直接写入', core.mergeDraft('', 'A') === 'A' && core.mergeDraft('   ', 'A') === 'A')
  check('mergeDraft 非空草稿空行分隔追加', core.mergeDraft('A\n\n', 'B') === 'A\n\nB')

  // formatQueue
  check('formatQueue 0 基转 1 基',
    core.formatQueue({ pointer: 2, total: 5 }) === '3/5' && core.formatQueue({ pointer: null, total: 5 }) === null
      && core.formatQueue({ pointer: 0, total: 0 }) === null)

  // insertIntoComposer：假 uiSession 走 composer 路径并追加合并草稿
  const embeddedReaderUrl = new URL(core.buildEmbeddedReaderUrl(core.BRIDGE, 'light'))
  check(
    'embedded reader URL carries theme only so reader.html follows /current',
    embeddedReaderUrl.origin === core.BRIDGE && embeddedReaderUrl.searchParams.get('theme') === 'light'
      && !embeddedReaderUrl.searchParams.has('left') && !embeddedReaderUrl.searchParams.has('right')
      && !embeddedReaderUrl.searchParams.has('page'),
    embeddedReaderUrl.toString(),
  )

  const drafts = []
  const fakeCtx = {
    get: (name) => (name === 'uiSession'
      ? {
        adapter: {
          current: {
            getSnapshot: () => ({
              props: { inputActions: { setDraft: (text) => drafts.push(text) } },
              hooks: { input: { getSnapshot: () => ({ draft: '已有草稿' }) } },
            }),
          },
        },
      }
      : undefined),
  }
  check(
    'insertIntoComposer 走 uiSession inputActions.setDraft 并合并草稿',
    core.insertIntoComposer(fakeCtx, '新文本') === 'composer' && drafts.length === 1 && drafts[0] === '已有草稿\n\n新文本',
    JSON.stringify(drafts),
  )
  // 无 uiSession 且 node 无 navigator.clipboard → failed（浏览器里退化 clipboard）
  check(
    'insertIntoComposer 服务缺失时退化（node 环境为 failed）',
    core.insertIntoComposer({ get: () => undefined }, 'x') === 'failed',
  )
}

/* ------------- composer/主题 API 静态验证（对照打包应用源码） ------------- */
/* 用正则确认 client.js 依赖的调用路径在打包应用内真实存在，路径漂移时报 FAIL。 */
try {
  const appNmStatic = 'E:/DSH1/DSH Desktop/resources/app/node_modules/@deepseek-ai'
  const conversationSrc = await readFile(join(appNmStatic, 'dsh-client-ui-conversation/lib/client.js'), 'utf8')
  check(
    '侦察复核：ui-conversation 暴露 inputActions.setDraft 公共面',
    conversationSrc.includes('props: { inputActions: shell.actions }')
      && /setDraft: \(text\) => \{/.test(conversationSrc),
  )
  const uiSessionSrc = await readFile(join(appNmStatic, 'dsh-client-ui-session/lib/client.js'), 'utf8')
  check(
    '侦察复核：uiSession 服务名与 current binding 快照',
    uiSessionSrc.includes('super(ctx, "uiSession")') && uiSessionSrc.includes('getSnapshot: () => this.currentBinding'),
  )
  const themeSrc = await readFile(join(appNmStatic, 'dsh-client-ui-theme/lib/client.js'), 'utf8')
  check(
    '侦察复核：theme 服务 provide 与 theme/change 事件',
    themeSrc.includes('ctx.provide("theme", theme)') && themeSrc.includes('ctx.emit("theme/change", this.snapshot)'),
  )
  const clientSrc = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  check(
    'client.js 实际接线 inputActions.setDraft 与 theme/change',
    clientSrc.includes('inputActions') && clientSrc.includes('setDraft') && clientSrc.includes("ctx.on('theme/change'"),
  )
} catch (error) {
  results.push(`SKIP  composer/主题 API 静态验证：${error instanceof Error ? error.message : String(error)}`)
}

console.log(results.join('\n'))
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
