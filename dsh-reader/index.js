/**
 * The `dsh-reader` tool plugin for the DeepSeek Harness (cordis). It registers
 * five model-facing tools: `reader_open`, which resolves one paper from the
 * local paper index and asks the DSH Desktop reader bridge to make it the
 * current paper of the in-app bilingual (EN left / ZH right) reader panel;
 * `reader_next`, the「下一篇」flow that optionally writes a reading summary
 * back to the current paper card (source「DSH 阅读讨论」), marks the current
 * PDF read, advances the reading queue (reader-queue.json) and opens the next
 * unread paper; `reader_skip`, the「过」flow that advances without writing
 * back; `reader_status`, which reports bridge current + queue position; and
 * `reader_save_thinking`, which pipes one reading note into the local paper
 * card's 「## 阅读思考」 section through `append_thinking.py`.
 *
 * First-party dependencies (`@deepseek-ai/schemastery` for the Config schema
 * and `@deepseek-ai/dsh-tools` for `defineTool`) exist inside the packaged
 * DSH Desktop app, so the plugin imports them when they resolve. Because this
 * directory may be mounted from outside the app tree — where bare specifiers
 * do not resolve under plain Node ESM — both imports degrade gracefully to
 * small zero-dependency equivalents that honor the same contracts
 * (standard-schema `~standard.validate` for Config; the observed
 * `defineTool` parameter-spec/validation behavior for tools).
 * @module dsh-reader
 */

import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { resolveReaderSessionLocation } from './private-session-path.js'
import {
  buildCurrentPayload,
  createPaperGraphAdapter,
  isLiveRead,
  normalizeReaderEntry,
  prepareNormalizedReaderPaperResolver,
} from './paper-graph-adapter.js'

/* ------------------------------------------------------------------------ */
/* Optional first-party dependencies with zero-dependency fallbacks          */
/* ------------------------------------------------------------------------ */

/** Schemastery default export, or `null` when the bare specifier does not resolve. */
let z = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  z = mod.default ?? null
} catch {
  z = null
}

/** First-party `defineTool`, or `null` when the bare specifier does not resolve. */
let firstPartyDefineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  firstPartyDefineTool = typeof mod.defineTool === 'function' ? mod.defineTool : null
} catch {
  firstPartyDefineTool = null
}

/* ------------------------------------------------------------------------ */
/* Plugin identity and config                                                */
/* ------------------------------------------------------------------------ */

/** Cordis plugin name. */
export const name = 'dsh-reader'
/** The tool registry must be mounted before tools register. */
export const inject = ['tools']

/** Default config values, applied for every key the deployment omits. */
const DEFAULT_BRIDGE_PRIVATE_ROOT = resolveReaderSessionLocation().privateRoot
const DEFAULT_BRIDGE_TOKEN_PATH = DEFAULT_BRIDGE_PRIVATE_ROOT
  ? join(DEFAULT_BRIDGE_PRIVATE_ROOT, 'reader-bridge-session.token')
  : 'C:/__dsh_reader_private_session_unavailable__'
const DEFAULT_CONFIG = {
  bridgeUrl: 'http://127.0.0.1:58812',
  bridgeTokenPath: DEFAULT_BRIDGE_TOKEN_PATH,
  bridgeStartScript: 'E:/DSH1/paper-reader/start-reader-bridge.ps1',
  papersPath: 'E:/DSH1/paper-reader/papers.json',
  queuePath: 'E:/DSH1/paper-reader/reader-queue.json',
  graphPath: 'E:/CLI/llm-wiki/_wiki/network/graph.json',
  vaultName: 'llm-wiki',
  pythonCmd: 'python',
  appendScript: 'E:/CLI/llm-wiki/scripts/append_thinking.py',
}

/**
 * @typedef {object} Config
 * @property {string} [bridgeUrl] - DSH 阅读桥（Electron 侧 HTTP 服务）的地址，默认 `http://127.0.0.1:58812`。
 * @property {string} [papersPath] - 论文索引 JSON 的绝对路径，默认 `E:/DSH1/paper-reader/papers.json`。
 * @property {string} [queuePath] - 阅读队列 JSON 的绝对路径，默认 `E:/DSH1/paper-reader/reader-queue.json`。
 * @property {string} [pythonCmd] - 启动 Python 的命令，默认 `python`。
 * @property {string} [appendScript] - `append_thinking.py` 的绝对路径，默认 `E:/CLI/llm-wiki/scripts/append_thinking.py`。
 */

/**
 * Minimal standard-schema wrapper for the zero-dependency Config fallback.
 * Cordis resolves plugin config through `Config['~standard'].validate(config)`,
 * synchronously, expecting `{ value }` or `{ issues: [{ message, path }] }`.
 * @param {(input: unknown) => { value: unknown } | { issues: { message: string, path?: string[] }[] }} validate
 */
function standardSchema(validate) {
  return { '~standard': { version: 1, vendor: 'dsh-reader', validate } }
}

/** Zero-dependency Config validator mirroring the schemastery schema below. */
const fallbackConfig = standardSchema((input) => {
  const issues = []
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const value = { ...DEFAULT_CONFIG, ...source }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      issues.push({ message: `dsh-reader config '${key}' must be a non-empty string`, path: [key] })
    }
  }
  return issues.length > 0 ? { issues } : { value }
})

/** Plugin config schema (schemastery when resolvable, zero-dependency otherwise). */
export const Config = z !== null
  ? z.object({
    bridgeUrl: z.string().default(DEFAULT_CONFIG.bridgeUrl),
    bridgeTokenPath: z.string().default(DEFAULT_CONFIG.bridgeTokenPath),
    bridgeStartScript: z.string().default(DEFAULT_CONFIG.bridgeStartScript),
    papersPath: z.string().default(DEFAULT_CONFIG.papersPath),
    queuePath: z.string().default(DEFAULT_CONFIG.queuePath),
    graphPath: z.string().default(DEFAULT_CONFIG.graphPath),
    vaultName: z.string().default(DEFAULT_CONFIG.vaultName),
    pythonCmd: z.string().default(DEFAULT_CONFIG.pythonCmd),
    appendScript: z.string().default(DEFAULT_CONFIG.appendScript),
  })
  : fallbackConfig

/* ------------------------------------------------------------------------ */
/* Zero-dependency defineTool fallback                                       */
/* ------------------------------------------------------------------------ */

/**
 * Compile one property-map schema spec (the `type` / `required` flag /
 * `properties` / `items` dialect used by first-party tools) into plain JSON
 * Schema. Only the constructs this plugin declares are handled.
 * @param {Record<string, unknown>} spec
 */
function compileSchemaSpec(spec) {
  const out = {}
  if (typeof spec.type === 'string') out.type = spec.type === 'integer' ? 'integer' : spec.type
  if (typeof spec.description === 'string') out.description = spec.description
  if (Array.isArray(spec.enum)) out.enum = spec.enum
  if (spec.additionalProperties === false) out.additionalProperties = false
  if (spec.properties !== null && typeof spec.properties === 'object') {
    out.properties = {}
    const required = []
    for (const [key, child] of Object.entries(spec.properties)) {
      const { required: isRequired, ...rest } = child
      out.properties[key] = compileSchemaSpec(rest)
      if (isRequired === true) required.push(key)
    }
    if (required.length > 0) out.required = required
  }
  if (spec.items !== null && typeof spec.items === 'object') out.items = compileSchemaSpec(spec.items)
  return out
}

/**
 * Validate tool arguments against a compiled parameter JSON schema, returning
 * human-readable violations (empty means valid). Covers the types this plugin
 * declares: string, integer, number, boolean, object.
 * @param {Record<string, unknown>} schema
 * @param {unknown} args
 * @returns {string[]}
 */
function validateArgsFallback(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object']
  const violations = []
  const properties = schema.properties ?? {}
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) violations.push(`missing required argument '${key}'`)
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key]
    if (spec === undefined || value === undefined) continue
    if (spec.type === 'string' && typeof value !== 'string') violations.push(`argument '${key}' must be a string`)
    if (spec.type === 'boolean' && typeof value !== 'boolean') violations.push(`argument '${key}' must be a boolean`)
    if (spec.type === 'number' && typeof value !== 'number') violations.push(`argument '${key}' must be a number`)
    if (spec.type === 'integer' && !Number.isInteger(value)) violations.push(`argument '${key}' must be an integer`)
  }
  return violations
}

/**
 * Fallback `defineTool` honoring the first-party contract observed in
 * `@deepseek-ai/dsh-tools`: parameter specs compile to JSON Schema, args are
 * validated before the caller's `execute` runs, and the output carries a
 * `render(args, value)` presenter.
 * @param {Record<string, unknown>} options
 */
function defineToolFallback(options) {
  const parameters = {
    type: 'object',
    ...compileSchemaSpec({ type: 'object', properties: options.parameters }),
  }
  const outputSchema = compileSchemaSpec(options.output.schema)
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validateArgsFallback(parameters, args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

/** The active tool-definition helper (first-party when resolvable). */
const defineTool = firstPartyDefineTool ?? defineToolFallback

/* ------------------------------------------------------------------------ */
/* Paper index loading and selection                                         */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} PaperEntry
 * @property {string} title - display title.
 * @property {string | undefined} slug - index slug, when the entry declares one.
 * @property {string | undefined} pdfEn - English PDF path/URL.
 * @property {string | undefined} pdfZh - Chinese PDF path/URL, when available.
 * @property {number | undefined} score - index score, when present.
 * @property {boolean} read - whether the index marks the paper as read.
 */

/**
 * Normalize one raw index row, tolerating `pdf_en` / `pdf_zh` snake_case
 * variants alongside the canonical `pdfEn` / `pdfZh` keys.
 * @param {unknown} raw - one raw index row.
 * @param {number} index - zero-based position in the index.
 * @returns {PaperEntry}
 */
function normalizeEntry(raw, index) {
  return normalizeReaderEntry(raw, index)
}

/**
 * Read and parse the paper index. The file is either a bare array or an
 * object with a `papers` array; array order defines rank order (1-based).
 * @param {string} papersPath - absolute index path.
 * @returns {Promise<{ entries?: PaperEntry[], error?: Record<string, unknown> }>}
 */
async function loadPapers(papersPath) {
  let text
  try {
    text = await readFile(papersPath, 'utf8')
  } catch (error) {
    return {
      error: {
        ok: false,
        error: 'index_unavailable',
        message: `无法读取论文索引「${papersPath}」：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    return {
      error: {
        ok: false,
        error: 'index_invalid',
        message: `论文索引「${papersPath}」不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
  const list = Array.isArray(data) ? data
    : data !== null && typeof data === 'object' && Array.isArray(data.papers) ? data.papers
      : undefined
  if (list === undefined) {
    return {
      error: {
        ok: false,
        error: 'index_invalid',
        message: `论文索引「${papersPath}」应为数组或含 papers 数组的对象`,
      },
    }
  }
  return { entries: list.map((raw, index) => normalizeEntry(raw, index)) }
}

/** A missing or staged graph leaves legacy reader behavior available. */
export async function loadPaperGraph(graphPath) {
  try {
    const graph = JSON.parse(await readFile(graphPath, 'utf8'))
    const configuredRoot = graph !== null && typeof graph === 'object' && typeof graph.vault_root === 'string' && isAbsolute(graph.vault_root)
      ? graph.vault_root : dirname(dirname(dirname(graphPath)))
    return createPaperGraphAdapter(graph, {
      vaultRoot: configuredRoot,
    })
  } catch {
    return createPaperGraphAdapter(null)
  }
}

/**
 * Select one paper by rank (1-based, precedence over query) or by
 * case-insensitive substring over slug/title. Multiple query candidates are
 * reported back without opening anything.
 * @param {PaperEntry[]} entries
 * @param {{ query?: string, rank?: number }} args
 * @returns {{ entry?: PaperEntry, rank?: number, error?: Record<string, unknown> }}
 */
function selectPaper(entries, args) {
  if (args.rank !== undefined) {
    if (!Number.isInteger(args.rank) || args.rank < 1) {
      return { error: { ok: false, error: 'invalid_rank', message: `rank 必须是不小于 1 的整数，收到 ${String(args.rank)}` } }
    }
    if (args.rank > entries.length) {
      return {
        error: {
          ok: false,
          error: 'rank_out_of_range',
          message: `索引中只有 ${entries.length} 篇论文，rank=${args.rank} 超出范围`,
        },
      }
    }
    return { entry: entries[args.rank - 1], rank: args.rank }
  }
  if (typeof args.query === 'string' && args.query.trim() !== '') {
    const needle = args.query.trim().toLowerCase()
    const hits = []
    entries.forEach((entry, index) => {
      const inSlug = entry.slug !== undefined && entry.slug.toLowerCase().includes(needle)
      if (inSlug || entry.title.toLowerCase().includes(needle)) hits.push({ entry, rank: index + 1 })
    })
    if (hits.length === 0) {
      return {
        error: {
          ok: false,
          error: 'not_found',
          message: `没有论文匹配「${args.query}」（对 slug/title 做大小写不敏感子串匹配）`,
        },
      }
    }
    if (hits.length > 1) {
      return {
        error: {
          ok: false,
          error: 'ambiguous',
          message: `「${args.query}」匹配到 ${hits.length} 篇候选，请改用更精确的 query 或指定 rank`,
          candidates: hits.map(({ entry, rank }) => ({
            rank,
            ...(entry.slug === undefined ? {} : { slug: entry.slug }),
            title: entry.title,
          })),
        },
      }
    }
    return { entry: hits[0].entry, rank: hits[0].rank }
  }
  return { error: { ok: false, error: 'missing_selector', message: '需要提供 query 或 rank 之一来定位论文' } }
}

/* ------------------------------------------------------------------------ */
/* Reader bridge call                                                        */
/* ------------------------------------------------------------------------ */

/** Bridge request timeout in milliseconds. */
const BRIDGE_TIMEOUT_MS = 5000

async function bridgeAuthHeaders(tokenPath) {
  try {
    const token = (await readFile(tokenPath, 'utf8')).trim()
    if (token.length > 0) return { 'x-dsh-reader-token': token }
  } catch { /* bridge may not be running yet */ }
  return undefined
}

function bridgeAuthUnavailable() {
  return {
    ok: false,
    error: {
      ok: false,
      error: 'bridge_auth_unavailable',
      message: 'Reader bridge session is unavailable; start the local DSH bridge and retry.',
    },
  }
}

/** Return the Windows PowerShell binary without relying on PATH lookup. */
export function windowsPowerShellPath(systemRoot = process.env.SystemRoot) {
  const candidate = typeof systemRoot === 'string' ? systemRoot.trim() : ''
  const root = candidate.length > 0 && isAbsolute(candidate) ? candidate : 'C:/Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Build the non-secret launcher invocation used from plugin apply. */
export function buildBridgeStartupInvocation(config, systemRoot = process.env.SystemRoot) {
  const script = typeof config?.bridgeStartScript === 'string' ? config.bridgeStartScript : ''
  if (script.length === 0) return undefined
  return {
    command: windowsPowerShellPath(systemRoot),
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
  }
}

function startupDiagnostic(logger, marker, detail) {
  const output = logger !== null && typeof logger === 'object' && typeof logger.info === 'function'
    ? logger.info.bind(logger) : console.info
  const integer = Number.isInteger(detail) ? detail : undefined
  const errorCode = typeof detail === 'string' && /^[A-Z0-9_]{1,32}$/.test(detail) ? detail : undefined
  try {
    output(`[dsh-reader] ${marker}${integer === undefined && errorCode === undefined ? '' : ` ${integer ?? errorCode}`}`)
  } catch { /* Diagnostics never affect plugin registration. */ }
}

function safeStartupErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN'
}

/**
 * The desktop plugin is loaded only after DSH itself is starting. Launching
 * this bounded helper here lets it discover the fresh renderer listener
 * without CDP, a user-managed environment variable, or a modified app.asar.
 */
export function startBridgeInBackground(config, runtime = {}) {
  if ((runtime.platform ?? process.platform) !== 'win32') return
  const invocation = buildBridgeStartupInvocation(config, runtime.systemRoot ?? process.env.SystemRoot)
  if (invocation === undefined) return
  const launch = typeof runtime.spawn === 'function' ? runtime.spawn : spawn
  const logger = runtime.logger ?? console
  startupDiagnostic(logger, 'bridge_start_attempt')
  try {
    const child = launch(invocation.command, invocation.args, {
      // Detached PS5 exits without running its script under the native host.
      // The bounded helper stays attached; its bridge child has its own lifetime.
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    startupDiagnostic(logger, 'bridge_start_child_pid', Number.isInteger(child.pid) ? child.pid : -1)
    child.on('error', (error) => startupDiagnostic(logger, 'bridge_start_spawn_error', safeStartupErrorCode(error)))
    child.on('exit', (code) => startupDiagnostic(logger, 'bridge_start_helper_exit', Number.isInteger(code) ? code : -1))
    child.unref()
  } catch (error) {
    startupDiagnostic(logger, 'bridge_start_spawn_error', safeStartupErrorCode(error))
    // Tool calls remain structured bridge-unavailable results if startup is
    // blocked; never expose a token or make plugin loading fail.
  }
}

/**
 * POST one JSON payload to a reader bridge endpoint. Connection failures and
 * timeouts map to one structured `bridge_unavailable` result so the model
 * can tell the user exactly what to do.
 * @param {string} bridgeUrl
 * @param {string} endpoint - bridge path, e.g. `/open` or `/read`.
 * @param {Record<string, unknown>} payload
 * @param {AbortSignal | undefined} outerSignal - caller cancellation signal.
 * @returns {Promise<{ ok: boolean, status?: number, body?: string, error?: Record<string, unknown> }>}
 */
async function postBridge(bridgeUrl, tokenPath, endpoint, payload, outerSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('bridge timeout')), BRIDGE_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(outerSignal?.reason ?? new Error('cancelled'))
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) onOuterAbort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const url = `${bridgeUrl.replace(/\/+$/, '')}${endpoint}`
  try {
    const auth = await bridgeAuthHeaders(tokenPath)
    if (auth === undefined) return bridgeAuthUnavailable()
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) {
      let bridgePayload
      try { bridgePayload = JSON.parse(body) } catch { bridgePayload = undefined }
      const bridgeError = bridgePayload !== null && typeof bridgePayload === 'object' && !Array.isArray(bridgePayload)
        ? bridgePayload : undefined
      return {
        ok: false,
        error: {
          ok: false,
          error: typeof bridgeError?.error === 'string' ? bridgeError.error : 'bridge_error',
          message: typeof bridgeError?.message === 'string'
            ? bridgeError.message : `Reader bridge HTTP ${response.status}: ${body.slice(0, 500)}`,
          status: response.status,
          ...(bridgeError === undefined ? {} : { bridge: bridgeError }),
        },
      }
    }
    return { ok: true, status: response.status, body }
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    const detail = cause !== null && typeof cause === 'object' && 'code' in cause
      ? String(cause.code)
      : error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: {
        ok: false,
        error: 'bridge_unavailable',
        message: 'DSH 阅读桥未就绪，请重启 DSH Desktop',
        detail,
      },
    }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * POST the open request to the reader bridge (no `target`: only updates the
 * bridge's current-paper state, which the in-app reader panel picks up).
 * @param {string} bridgeUrl
 * @param {{ left: string, right?: string, page?: number, title: string }} payload
 * @param {AbortSignal | undefined} outerSignal - caller cancellation signal.
 */
function postOpen(bridgeUrl, tokenPath, payload, outerSignal) {
  return postBridge(bridgeUrl, tokenPath, '/open', payload, outerSignal)
}

/**
 * Mark one PDF path read/unread through the bridge (`POST /read`).
 * @param {string} bridgeUrl
 * @param {string} path - PDF path key used by the bridge's read/unread map.
 * @param {boolean} read
 * @param {AbortSignal | undefined} outerSignal
 */
function postRead(bridgeUrl, tokenPath, path, read, outerSignal) {
  return postBridge(bridgeUrl, tokenPath, '/read', { path, read }, outerSignal)
}

/**
 * GET the bridge's current-paper state (`GET /current`). Returns `{}` when no
 * paper is open. Bridge failures resolve to the same structured shape as
 * {@link postBridge} so callers can distinguish "empty" from "unavailable".
 * @param {string} bridgeUrl
 * @param {AbortSignal | undefined} outerSignal
 * @returns {Promise<{ ok: boolean, current?: Record<string, unknown>, error?: Record<string, unknown> }>}
 */
async function getCurrent(bridgeUrl, tokenPath, outerSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('bridge timeout')), BRIDGE_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(outerSignal?.reason ?? new Error('cancelled'))
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) onOuterAbort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const url = `${bridgeUrl.replace(/\/+$/, '')}/current`
  try {
    const auth = await bridgeAuthHeaders(tokenPath)
    if (auth === undefined) return bridgeAuthUnavailable()
    const response = await fetch(url, { headers: auth, signal: controller.signal })
    if (!response.ok) {
      return {
        ok: false,
        error: {
          ok: false,
          error: 'bridge_error',
          message: `阅读桥返回 HTTP ${response.status}`,
          status: response.status,
        },
      }
    }
    const data = await response.json()
    return {
      ok: true,
      current: data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {},
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        ok: false,
        error: 'bridge_unavailable',
        message: 'DSH 阅读桥未就绪，请重启 DSH Desktop',
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

/** Read the bridge's live per-PDF status overlay; unknown paths stay unread. */
async function getLiveReadState(bridgeUrl, tokenPath, outerSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('bridge timeout')), BRIDGE_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(outerSignal?.reason ?? new Error('cancelled'))
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) onOuterAbort()
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const auth = await bridgeAuthHeaders(tokenPath)
    if (auth === undefined) return bridgeAuthUnavailable()
    const response = await fetch(`${bridgeUrl.replace(/\/+$/, '')}/read-state`, { headers: auth, signal: controller.signal })
    if (!response.ok) {
      return { ok: false, error: { ok: false, error: 'bridge_error', message: `�Ķ��ŷ��� HTTP ${response.status}`, status: response.status } }
    }
    const data = await response.json()
    const state = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
    return { ok: true, state }
  } catch (error) {
    return { ok: false, error: { ok: false, error: 'bridge_unavailable', message: 'DSH �Ķ���δ������������ DSH Desktop', detail: error instanceof Error ? error.message : String(error) } }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

/* ------------------------------------------------------------------------ */
/* Reading queue (reader-queue.json)                                         */
/* ------------------------------------------------------------------------ */

/**
 * Stable queue identity for one paper: slug when present, else the title
 * (normalizeEntry guarantees a non-empty title).
 * @param {PaperEntry} entry
 */
function entryId(entry) {
  // Existing queues persist slug/title identities.  Resolve those lazily to
  // paper_id rather than rewriting a human-maintained order on first read.
  return entry.slug ?? entry.title
}

function queueOrderHash(order) {
  return createHash('sha256').update(JSON.stringify(order)).digest('hex')
}

/**
 * @typedef {object} ReaderQueue
 * @property {number} pointer - index into `order` of the current paper.
 * @property {string[]} order - queue order as paper ids (slug ?? title).
 */

/**
 * Load the reading queue, initializing it from the paper index order when the
 * file is missing or unreadable-as-JSON. The initialized queue is persisted
 * immediately so subsequent runs share one pointer.
 * @param {string} queuePath
 * @param {PaperEntry[]} entries
 * @returns {Promise<{ queue?: ReaderQueue, error?: Record<string, unknown> }>}
 */
async function loadQueue(queuePath, entries) {
  let text
  try {
    text = await readFile(queuePath, 'utf8')
  } catch {
    text = undefined // missing (or unreadable) file: initialize below
  }
  if (text !== undefined) {
    try {
      const data = JSON.parse(text)
      if (data !== null && typeof data === 'object' && !Array.isArray(data)
        && Array.isArray(data.order) && data.order.every((id) => typeof id === 'string')
        && Number.isInteger(data.pointer) && data.pointer >= 0) {
        return { queue: { pointer: data.pointer, order: data.order } }
      }
    } catch { /* fall through to reinitialize */ }
  }
  const queue = { pointer: 0, order: entries.map((entry) => entryId(entry)) }
  const saved = await saveQueue(queuePath, queue)
  if (saved !== undefined) return saved
  return { queue }
}

/**
 * Persist the reading queue.
 * @param {string} queuePath
 * @param {ReaderQueue} queue
 * @returns {Promise<Record<string, unknown> | undefined>} structured error, or undefined on success.
 */
async function saveQueue(queuePath, queue) {
  try {
    await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8')
    return undefined
  } catch (error) {
    return {
      error: {
        ok: false,
        error: 'queue_unwritable',
        message: `无法写入阅读队列「${queuePath}」：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}

/**
 * Locate the next unread paper at or after `fromIndex` in queue order.
 * Entries whose index row is `read: true` are skipped; ids that no longer
 * resolve to an index entry are skipped too.
 * @param {PaperEntry[]} entries
 * @param {ReaderQueue} queue
 * @param {number} fromIndex
 * @returns {{ index: number, id: string, entry: PaperEntry, rank: number } | undefined}
 */
function findNextUnread(entries, queue, fromIndex, liveState, resolver) {
  for (let i = fromIndex; i < queue.order.length; i += 1) {
    const paper = resolver.resolveQueue(queue.order[i])
    if (paper === undefined || isLiveRead(paper, liveState)) continue
    const rank = entries.findIndex((entry) => entry.pdfEn === paper.pdfEn) + 1
    return { index: i, id: queue.order[i], paper, rank }
  }
  return undefined
}

function queueIndexForPaper(entries, queue, paper, resolver) {
  for (let index = 0; index < queue.order.length; index += 1) {
    const queued = resolver.resolveQueue(queue.order[index])
    if (queued !== undefined && queued.paperId !== undefined && queued.paperId === paper.paperId) return index
    if (queued !== undefined && queued.paperId === undefined && queued.pdfEn === paper.pdfEn) return index
  }
  return undefined
}

function queuePaperResult(paper, rank, liveState) {
  return {
    ...(paper.paperId === undefined ? {} : { paper_id: paper.paperId }),
    ...(paper.slug === undefined ? {} : { slug: paper.slug }),
    title: paper.title,
    ...(paper.score === undefined ? {} : { score: paper.score }),
    ...(Number.isInteger(rank) && rank > 0 ? { rank } : {}),
    ...(paper.canonicalCard === undefined ? {} : { canonicalCard: paper.canonicalCard }),
    ...(liveState === undefined ? {} : { read: isLiveRead(paper, liveState) }),
  }
}

/* ------------------------------------------------------------------------ */
/* append_thinking.py subprocess                                             */
/* ------------------------------------------------------------------------ */

/** Child-process timeout for the append script. */
const PYTHON_TIMEOUT_MS = 30_000

/**
 * Spawn `<pythonCmd> <appendScript> <query> --stdin [--card C] [--question Q]
 * --source <source>`, feeding the note body over stdin. Every failure
 * mode (missing Python, non-zero exit, timeout) resolves to a structured
 * result instead of throwing.
 * @param {Required<Config>} config
 * @param {{ query: string, text: string, canonicalCard?: string, question?: string, source?: string }} args
 * @returns {Promise<Record<string, unknown>>}
 */
function runAppendScript(config, args) {
  return new Promise((resolve) => {
    const argv = [config.appendScript, args.query, '--stdin']
    if (typeof args.canonicalCard === 'string' && args.canonicalCard.length > 0) argv.push('--card', args.canonicalCard)
    if (typeof args.question === 'string' && args.question.length > 0) argv.push('--question', args.question)
    argv.push('--source', typeof args.source === 'string' && args.source.length > 0 ? args.source : 'DSH 阅读器')

    let child
    try {
      child = spawn(config.pythonCmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({
        ok: false,
        error: 'python_unavailable',
        message: `无法启动 Python 命令「${config.pythonCmd}」：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, PYTHON_TIMEOUT_MS)

    child.on('error', (error) => {
      finish({
        ok: false,
        error: 'python_unavailable',
        message: `无法启动 Python 命令「${config.pythonCmd}」，请确认已安装 Python 或调整插件配置 pythonCmd`,
        detail: error.message,
      })
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      if (timedOut) {
        finish({
          ok: false,
          error: 'python_timeout',
          message: `append_thinking.py 超过 ${PYTHON_TIMEOUT_MS / 1000} 秒未退出，已终止`,
          stdout,
          stderr,
        })
        return
      }
      if (code === 0) {
        finish({ ok: true, stdout, stderr })
      } else {
        finish({
          ok: false,
          error: 'script_failed',
          message: `append_thinking.py 退出码 ${String(code)}：${stderr.trim() || stdout.trim() || '（无输出）'}`,
          exitCode: code,
          stdout,
          stderr,
        })
      }
    })
    child.stdin.on('error', () => { /* EPIPE: the child exited before reading stdin */ })
    child.stdin.write(args.text)
    child.stdin.end()
  })
}

/* ------------------------------------------------------------------------ */
/* Tool descriptions and registration                                        */
/* ------------------------------------------------------------------------ */

const READER_OPEN_DESCRIPTION = '在 DSH 桌面端拉起论文阅读窗口（左栏英文原文、右栏中文译文的双栏对照）。从本地论文索引选一篇并打开：给 rank（索引排序后的第 N 篇，从 1 开始）或给 query（对 slug/title 做大小写不敏感子串匹配）；同时给出时以 rank 为准。query 命中多篇候选时返回候选列表而不打开，请改用更精确的 query 或指定 rank。读论文、讨论论文内容时优先用本工具拉起中英双栏；若返回 bridge_unavailable，请提示用户「DSH 阅读桥未就绪，请重启 DSH Desktop」。'

const READER_SAVE_THINKING_DESCRIPTION = '把一段阅读思考追加到本地论文卡片的「## 阅读思考」小节（调用 append_thinking.py，正文经 stdin 传入）。query 用于定位卡片（标题/slug 子串，大小写不敏感；多候选时脚本会拒绝写入并列出候选，此时请改用更精确的 query）。通常在 reader_open 阅读之后调用，把本轮讨论沉淀回卡片。'

const READER_NEXT_DESCRIPTION = '「下一篇」流程：若给了 summary 且队列指针处有论文，先把 summary 回写到当前论文卡片（来源标记为「DSH 阅读讨论」，question 可空）并把当前 PDF 标记为已读；然后指针前进，取下一篇未读论文（跳过索引中 read:true 的），交给阅读桥更新前端阅读面板。返回 archived（是否完成回写）、current（刚结束的论文）和 next（新打开的论文，含 score/rank）。队列到末尾时返回 end_of_queue，此时可提示用户已全部读完。'

const READER_SKIP_DESCRIPTION = '「过」：不回写、不标记已读，仅把队列指针前进一篇并打开下一篇未读论文（跳过索引中 read:true 的）。用于用户对当前论文没有想法、直接跳过的场景。队列到末尾时返回 end_of_queue。'

const READER_STATUS_DESCRIPTION = '查看阅读进度：阅读桥当前打开的论文（current）、阅读队列位置（pointer/total）、队列指针处论文的 slug/title/score/read。'

const READER_OPEN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    title: { type: 'string' },
    paper_id: { type: 'string' },
    slug: { type: 'string' },
    rank: { type: 'integer' },
    left: { type: 'string' },
    right: { type: 'string' },
    page: { type: 'integer' },
    bridgeStatus: { type: 'integer' },
    bridgeBody: { type: 'string' },
    error: { type: 'string' },
    message: { type: 'string' },
    detail: { type: 'string' },
    status: { type: 'integer' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rank: { type: 'integer', required: true },
          slug: { type: 'string' },
          title: { type: 'string', required: true },
        },
      },
    },
  },
}

const READER_SAVE_THINKING_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: { type: 'string' },
    message: { type: 'string' },
    detail: { type: 'string' },
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
}

const QUEUE_PAPER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    paper_id: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string', required: true },
    score: { type: 'number' },
    rank: { type: 'integer' },
    canonicalCard: { type: 'string' },
    read: { type: 'boolean' },
  },
}

const READER_NEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    archived: { type: 'boolean' },
    current: QUEUE_PAPER_SCHEMA,
    next: QUEUE_PAPER_SCHEMA,
    error: { type: 'string' },
    message: { type: 'string' },
    detail: { type: 'string' },
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
}

const READER_SKIP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    current: QUEUE_PAPER_SCHEMA,
    next: QUEUE_PAPER_SCHEMA,
    error: { type: 'string' },
    message: { type: 'string' },
    detail: { type: 'string' },
  },
}

const READER_STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    bridgeAvailable: { type: 'boolean', required: true },
    current: {
      type: 'object',
      additionalProperties: true,
      properties: {},
    },
    queue: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pointer: { type: 'integer', required: true },
        total: { type: 'integer', required: true },
      },
    },
    paper: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paper_id: { type: 'string' },
        slug: { type: 'string' },
        title: { type: 'string', required: true },
        score: { type: 'number' },
        read: { type: 'boolean' },
        canonicalCard: { type: 'string' },
      },
    },
    selectedPaper: QUEUE_PAPER_SCHEMA,
    queuePaper: QUEUE_PAPER_SCHEMA,
    error: { type: 'string' },
    message: { type: 'string' },
    detail: { type: 'string' },
  },
}

/** Render one reader_open result as model-facing text. */
function renderReaderOpen(_args, value) {
  if (value.ok === true) {
    const pageNote = typeof value.page === 'number' ? `，跳到第 ${value.page} 页` : ''
    const rightNote = typeof value.right === 'string' ? '（中英双栏）' : '（仅英文，无中文译文）'
    return [{ type: 'text', text: `已打开《${value.title ?? ''}》${rightNote}${pageNote}` }]
  }
  const lines = [String(value.message ?? '打开失败')]
  if (Array.isArray(value.candidates)) {
    lines.push('候选：')
    for (const candidate of value.candidates) {
      lines.push(`  ${candidate.rank}. ${candidate.title}${typeof candidate.slug === 'string' ? ` (${candidate.slug})` : ''}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render one reader_save_thinking result as model-facing text. */
function renderSaveThinking(_args, value) {
  if (value.ok === true) {
    return [{ type: 'text', text: `已写入阅读思考：${String(value.stdout ?? '').trim() || 'ok'}` }]
  }
  return [{ type: 'text', text: String(value.message ?? '写入失败') }]
}

/** Render one reader_next result as model-facing text. */
function renderReaderNext(_args, value) {
  if (value.ok === true) {
    const archivedNote = value.archived === true ? '，已回写并标记已读' : ''
    const scoreNote = typeof value.next?.score === 'number' ? `（score ${value.next.score}，第 ${value.next.rank} 篇）` : ''
    return [{ type: 'text', text: `已结束《${value.current?.title ?? '—'}》${archivedNote}，打开下一篇《${value.next?.title ?? ''}》${scoreNote}` }]
  }
  if (value.error === 'end_of_queue') {
    return [{ type: 'text', text: '阅读队列已到末尾，没有更多未读论文了' }]
  }
  return [{ type: 'text', text: String(value.message ?? '「下一篇」失败') }]
}

/** Render one reader_skip result as model-facing text. */
function renderReaderSkip(_args, value) {
  if (value.ok === true) {
    return [{ type: 'text', text: `已跳过《${value.current?.title ?? '—'}》，打开《${value.next?.title ?? ''}》` }]
  }
  if (value.error === 'end_of_queue') {
    return [{ type: 'text', text: '阅读队列已到末尾，没有更多未读论文了' }]
  }
  return [{ type: 'text', text: String(value.message ?? '跳过失败') }]
}

/** Render one reader_status result as model-facing text. */
function renderReaderStatus(_args, value) {
  if (value.ok !== true) return [{ type: 'text', text: String(value.message ?? '查询失败') }]
  const lines = []
  const current = value.current
  const hasCurrent = current !== null && typeof current === 'object' && typeof current.title === 'string'
  lines.push(hasCurrent
    ? `阅读桥当前打开：《${current.title}》${typeof current.page === 'number' ? `（第 ${current.page} 页）` : ''}`
    : value.bridgeAvailable === true ? '阅读桥当前没有打开的论文' : '阅读桥不可达（current 未知）')
  lines.push(`队列位置：${value.queue.pointer}/${value.queue.total}`)
  if (value.paper !== undefined) {
    const parts = [value.paper.title]
    if (typeof value.paper.slug === 'string') parts.push(`slug=${value.paper.slug}`)
    if (typeof value.paper.score === 'number') parts.push(`score=${value.paper.score}`)
    parts.push(value.paper.read === true ? '已读' : '未读')
    lines.push(`指针处论文：${parts.join('，')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Mount the plugin: register `reader_open`, `reader_save_thinking`,
 * `reader_next`, `reader_skip` and `reader_status`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying the tool registry.
 * @param {Config} config - validated plugin config.
 */
export function apply(ctx, config) {
  // Cordis already resolved Config (defaults applied); merging again keeps
  // direct invocations (tests, headless harnesses) safe.
  const resolved = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  startBridgeInBackground(resolved)
  let queueTransitionTail = Promise.resolve()
  async function serializeQueueTransition(work) {
    const previous = queueTransitionTail
    let release
    queueTransitionTail = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }

  ctx.tools.register(defineTool({
    name: 'reader_open',
    description: READER_OPEN_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        description: '论文标题或 slug 的子串（大小写不敏感）。与 rank 同时给出时以 rank 为准。',
      },
      rank: {
        type: 'integer',
        description: '按论文索引顺序取第 N 篇（从 1 开始）。',
      },
      page: {
        type: 'integer',
        description: '可选，打开后跳转到的 PDF 页码（从 1 开始）。',
      },
    },
    output: {
      schema: READER_OPEN_OUTPUT_SCHEMA,
      render: renderReaderOpen,
    },
    async execute(args, exec) {
      return serializeQueueTransition(async () => {
      const { entries, error: loadError } = await loadPapers(resolved.papersPath)
      if (loadError !== undefined) return loadError
      const { entry, rank, error: selectError } = selectPaper(entries, args)
      if (selectError !== undefined) return selectError
      const graph = await loadPaperGraph(resolved.graphPath)
      const paperResolver = prepareNormalizedReaderPaperResolver(entries, graph)
      const paper = paperResolver.resolveCurrent({ paper_id: entry.paperId, slug: entry.slug, left: entry.pdfEn })
      if (paper === undefined) {
        return {
          ok: false,
          error: 'no_pdf',
          message: `《${entry.title}》在索引中没有 pdfEn 字段，无法打开`,
          title: entry.title,
          rank,
        }
      }
      const payload = buildCurrentPayload(paper, { page: args.page, vaultName: resolved.vaultName })
      if (payload === undefined) return { ok: false, error: 'no_pdf', message: `《${entry.title}》没有可打开的英文原文 PDF`, title: entry.title, rank }
      const posted = await postOpen(resolved.bridgeUrl, resolved.bridgeTokenPath, payload, exec?.signal)
      if (!posted.ok) return { ...posted.error, title: entry.title, rank }
      return {
        ok: true,
        title: paper.title,
        ...(paper.slug === undefined ? {} : { slug: paper.slug }),
        ...(paper.paperId === undefined ? {} : { paper_id: paper.paperId }),
        rank,
        left: paper.pdfEn,
        ...(paper.pdfZh === undefined ? {} : { right: paper.pdfZh }),
        ...(typeof args.page === 'number' ? { page: args.page } : {}),
        bridgeStatus: posted.status,
        bridgeBody: posted.body,
      }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reader_save_thinking',
    description: READER_SAVE_THINKING_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '定位论文卡片的标题/slug 子串（大小写不敏感）。',
      },
      text: {
        type: 'string',
        required: true,
        description: '思考正文（Markdown），经 stdin 传给 append_thinking.py。',
      },
      question: {
        type: 'string',
        description: '可选：本次讨论的问题，会作为条目的问题行写入卡片。',
      },
    },
    output: {
      schema: READER_SAVE_THINKING_OUTPUT_SCHEMA,
      render: renderSaveThinking,
    },
    async execute(args, _exec) {
      return runAppendScript(resolved, args)
    },
  }))

  /**
   * Shared tail of the「下一篇」/「过」flows: advance the queue pointer past
   * `fromIndex - 1` to the next unread paper, persist, and hand it to the
   * bridge. Returns the structured tool result.
   * @param {Required<Config>} config
   * @param {PaperEntry[]} entries
   * @param {ReaderQueue} queue
   * @param {number} fromIndex - first queue index to consider.
   * @param {{ archived?: boolean, currentPaper?: Record<string, unknown> }} extra
   * @param {AbortSignal | undefined} signal
   */
  async function advanceQueue(config, entries, queue, fromIndex, extra, signal, paperResolver, liveState) {
    const next = findNextUnread(entries, queue, fromIndex, liveState, paperResolver)
    const currentFields = extra.currentPaper === undefined ? {} : { current: extra.currentPaper }
    if (next === undefined) {
      return {
        ok: false,
        error: 'end_of_queue',
        message: '阅读队列已到末尾，没有更多未读论文了',
        ...(extra.archived === undefined ? {} : { archived: extra.archived }),
        ...currentFields,
      }
    }
    const payload = buildCurrentPayload(next.paper, { vaultName: config.vaultName })
    if (payload === undefined) return { ok: false, error: 'next_unresolved', message: '���в�����ȷ����һƪ���ģ�δǰ������', ...currentFields }
    const expectedCurrentRevision = typeof extra.bridgeCurrent?.revision === 'string'
      ? extra.bridgeCurrent.revision : extra.bridgeCurrent?.updatedAt
    if (typeof expectedCurrentRevision !== 'string') return { ok: false, error: 'current_unresolved', message: 'Current reader revision is unavailable; queue unchanged.', ...currentFields }
    const posted = await postBridge(config.bridgeUrl, config.bridgeTokenPath, '/advance', {
      expected: { currentRevision: expectedCurrentRevision, queuePointer: queue.pointer, queueOrderHash: queueOrderHash(queue.order) },
      next: payload,
      nextPointer: next.index,
    }, signal)
    if (!posted.ok) return { ...posted.error, ...currentFields }
    const nextPaper = queuePaperResult(next.paper, next.rank, liveState)
    return {
      ok: true,
      ...(extra.archived === undefined ? {} : { archived: extra.archived }),
      ...currentFields,
      next: nextPaper,
    }
  }

  ctx.tools.register(defineTool({
    name: 'reader_next',
    description: READER_NEXT_DESCRIPTION,
    parameters: {
      summary: {
        type: 'string',
        description: '可选：对当前论文的阅读小结（Markdown）。给出且队列指针处有论文时，会先回写到当前卡片（来源「DSH 阅读讨论」）并标记已读，再前进到下一篇。',
      },
      question: {
        type: 'string',
        description: '可选：本次讨论的问题，随 summary 一起作为条目的问题行写入当前卡片。',
      },
    },
    output: {
      schema: READER_NEXT_OUTPUT_SCHEMA,
      render: renderReaderNext,
    },
    async execute(args, exec) {
      return serializeQueueTransition(async () => {
      const { entries, error: loadError } = await loadPapers(resolved.papersPath)
      if (loadError !== undefined) return loadError
      const { queue, error: queueError } = await loadQueue(resolved.queuePath, entries)
      if (queueError !== undefined) return queueError

      const [graph, bridge, readOverlay] = await Promise.all([
        loadPaperGraph(resolved.graphPath),
        getCurrent(resolved.bridgeUrl, resolved.bridgeTokenPath, exec?.signal),
        getLiveReadState(resolved.bridgeUrl, resolved.bridgeTokenPath, exec?.signal),
      ])
      if (!bridge.ok) return bridge.error
      if (!readOverlay.ok) return readOverlay.error
      const paperResolver = prepareNormalizedReaderPaperResolver(entries, graph)
      const current = paperResolver.resolveCurrent(bridge.current)
      if (current === undefined) return { ok: false, error: 'current_unresolved', message: 'Current reader selection cannot be resolved; queue unchanged.' }
      if (typeof current.pdfEn !== 'string' || current.pdfEn.length === 0) {
        return {
          ok: false,
          error: 'missing_original_asset',
          message: 'Current reader item has no recorded original PDF; no card, read state, or queue change was made.',
          ...(current.canonicalCard === undefined ? {} : { canonicalCard: current.canonicalCard }),
        }
      }
      const currentIndex = queueIndexForPaper(entries, queue, current, paperResolver)
      if (currentIndex === undefined) return { ok: false, error: 'current_not_in_queue', message: 'Current reader selection is absent from the retained queue; queue unchanged.' }
      const currentPaper = queuePaperResult(current, entries.findIndex((entry) => entry.pdfEn === current.pdfEn) + 1, readOverlay.state)
      const expectedCurrentRevision = typeof bridge.current?.revision === 'string' ? bridge.current.revision : bridge.current?.updatedAt
      if (typeof expectedCurrentRevision !== 'string') return { ok: false, error: 'current_unresolved', message: 'Current reader revision is unavailable; queue unchanged.' }
      const validation = await postBridge(resolved.bridgeUrl, resolved.bridgeTokenPath, '/validate-current', {
        expected: { currentRevision: expectedCurrentRevision, queuePointer: queue.pointer, queueOrderHash: queueOrderHash(queue.order) },
      }, exec?.signal)
      if (!validation.ok) return { ...validation.error, current: currentPaper }

      let archived = false
      if (typeof args.summary === 'string' && args.summary.trim() !== '') {
        const appended = await runAppendScript(resolved, {
          query: current.slug ?? current.title,
          text: args.summary,
          canonicalCard: current.canonicalCard,
          question: args.question,
          source: 'DSH 阅读讨论',
        })
        if (appended.ok !== true) {
          return {
            ...appended,
            message: `回写当前卡片失败，未前进队列：${String(appended.message ?? '未知错误')}`,
            archived: false,
            ...(currentPaper === undefined ? {} : { current: currentPaper }),
          }
        }
        {
          const marked = await postRead(resolved.bridgeUrl, resolved.bridgeTokenPath, current.pdfEn, true, exec?.signal)
          if (!marked.ok) {
            return {
              ...marked.error,
              message: `标记已读失败，未前进队列：${String(marked.error.message ?? '未知错误')}`,
              archived: false,
              current: currentPaper,
            }
          }
        }
        readOverlay.state[current.pdfEn] = true
        archived = true
      }

      return advanceQueue(resolved, entries, queue, currentIndex + 1, {
        archived,
        currentPaper,
        bridgeCurrent: bridge.current,
      }, exec?.signal, paperResolver, readOverlay.state)
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reader_skip',
    description: READER_SKIP_DESCRIPTION,
    parameters: {},
    output: {
      schema: READER_SKIP_OUTPUT_SCHEMA,
      render: renderReaderSkip,
    },
    async execute(_args, exec) {
      return serializeQueueTransition(async () => {
      const { entries, error: loadError } = await loadPapers(resolved.papersPath)
      if (loadError !== undefined) return loadError
      const { queue, error: queueError } = await loadQueue(resolved.queuePath, entries)
      if (queueError !== undefined) return queueError

      const [graph, bridge, readOverlay] = await Promise.all([
        loadPaperGraph(resolved.graphPath),
        getCurrent(resolved.bridgeUrl, resolved.bridgeTokenPath, exec?.signal),
        getLiveReadState(resolved.bridgeUrl, resolved.bridgeTokenPath, exec?.signal),
      ])
      if (!bridge.ok) return bridge.error
      if (!readOverlay.ok) return readOverlay.error
      const paperResolver = prepareNormalizedReaderPaperResolver(entries, graph)
      const current = paperResolver.resolveCurrent(bridge.current)
      if (current === undefined) return { ok: false, error: 'current_unresolved', message: 'Current reader selection cannot be resolved; queue unchanged.' }
      const currentIndex = queueIndexForPaper(entries, queue, current, paperResolver)
      if (currentIndex === undefined) return { ok: false, error: 'current_not_in_queue', message: 'Current reader selection is absent from the retained queue; queue unchanged.' }
      const currentPaper = queuePaperResult(current, entries.findIndex((entry) => entry.pdfEn === current.pdfEn) + 1, readOverlay.state)

      return advanceQueue(resolved, entries, queue, currentIndex + 1, {
        currentPaper,
        bridgeCurrent: bridge.current,
      }, exec?.signal, paperResolver, readOverlay.state)
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reader_status',
    description: READER_STATUS_DESCRIPTION,
    parameters: {},
    output: {
      schema: READER_STATUS_OUTPUT_SCHEMA,
      render: renderReaderStatus,
    },
    async execute(_args, exec) {
      const { entries, error: loadError } = await loadPapers(resolved.papersPath)
      if (loadError !== undefined) return loadError
      const { queue, error: queueError } = await loadQueue(resolved.queuePath, entries)
      if (queueError !== undefined) return queueError

      const [graph, bridge, readOverlay] = await Promise.all([
        loadPaperGraph(resolved.graphPath),
        getCurrent(resolved.bridgeUrl, resolved.bridgeTokenPath, exec?.signal),
        getLiveReadState(resolved.bridgeUrl, resolved.bridgeTokenPath, exec?.signal),
      ])
      const paperResolver = prepareNormalizedReaderPaperResolver(entries, graph)
      const currentId = queue.pointer < queue.order.length ? queue.order[queue.pointer] : undefined
      const currentEntry = currentId === undefined ? undefined : paperResolver.resolveQueue(currentId)
      const selected = bridge.ok ? paperResolver.resolveCurrent(bridge.current) : undefined
      const queuePaper = currentEntry === undefined ? undefined
        : queuePaperResult(currentEntry, entries.findIndex((entry) => entry.pdfEn === currentEntry.pdfEn) + 1,
          readOverlay.ok ? readOverlay.state : undefined)

      return {
        ok: true,
        bridgeAvailable: bridge.ok,
        current: bridge.ok ? bridge.current : {},
        ...(bridge.ok ? {} : { detail: String(bridge.error.detail ?? bridge.error.message ?? '') }),
        queue: { pointer: queue.pointer, total: queue.order.length },
        ...(queuePaper === undefined ? {} : { paper: queuePaper, queuePaper }),
        ...(selected === undefined ? {} : {
          selectedPaper: queuePaperResult(selected, entries.findIndex((entry) => entry.pdfEn === selected.pdfEn) + 1,
            readOverlay.ok ? readOverlay.state : undefined),
        }),
      }
    },
  }))
}

/** Cordis object-plugin shape: named fields are mirrored as a default export. */
export default { name, inject, Config, apply }
