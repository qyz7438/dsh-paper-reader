// DSH Reader Bridge — standalone test harness.
// This mirrors the logic injected into DSH Desktop resources/app/out/main/index.js
// (block marked "// === DSH READER BRIDGE (2026-09-16) ===") so the HTTP bridge can be
// tested with plain node, without Electron. BrowserWindow creation is replaced by a
// logging stub; everything else is identical.
import { createServer } from "node:http";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveReaderSessionLocation } from "./dsh-reader/private-session-path.js";
import { readerOpenObsidian } from "./reader-obsidian-navigation.mjs";
import {
  buildCurrentPayload,
  createPaperGraphAdapter,
  isLiveRead,
  normalizeReaderEntry,
  prepareReaderPaperResolver,
  resolveCurrentPaper,
  resolveQueuePaper,
} from "./dsh-reader/paper-graph-adapter.js";

const DSH_READER_BRIDGE_PORT = 58812;
const DSH_READER_BRIDGE_HOST = "127.0.0.1";
const DSH_READER_ROOT = process.env.DSH_READER_ROOT || "E:\\DSH1\\paper-reader";
const DSH_READER_STARTUP_STATUS_FILE = join(DSH_READER_ROOT, "verify", "bridge-startup-status.log");
const DSH_READER_STARTUP_STATUS_MAX_BYTES = 32 * 1024;
const DSH_READER_STARTUP_STAGES = new Set([
  "main_entry", "journal_recovery", "private_root_missing", "private_path_source", "trusted_tool", "sid_query", "sid_missing",
  "sid_child_status", "sid_stderr_present", "sid_error_class", "sid_error_id",
  "mkdir_private", "set_directory_acl", "write_token", "set_token_acl", "verify_directory_acl",
  "verify_token_acl", "listener_ready", "listener_error",
]);
const DSH_READER_LIBRARY_ROOT = process.env.DSH_READER_LIBRARY_ROOT || "E:\\CLI\\llm-wiki";
const DSH_READER_STATE_FILE = join(DSH_READER_ROOT, "reader-state.json");
const DSH_READER_ADVANCE_JOURNAL = join(DSH_READER_ROOT, "reader-advance-journal.json");
const DSH_READER_THINKING_SCRIPT = process.env.DSH_READER_THINKING_SCRIPT
  || join(DSH_READER_LIBRARY_ROOT, "scripts", "append_thinking.py");
const DSH_READER_PYTHON_CMD = process.env.DSH_READER_PYTHON
  || join(process.env.USERPROFILE || process.env.HOME || "", ".config", "llm-wiki", "venv", "Scripts", "python.exe");
const DSH_READER_BODY_LIMIT = 16 * 1024 * 1024;
const DSH_READER_SESSION_LOCATION = resolveReaderSessionLocation();
const DSH_READER_PRIVATE_ROOT = DSH_READER_SESSION_LOCATION.privateRoot;
const DSH_READER_AUTH_FILE = DSH_READER_PRIVATE_ROOT
  ? join(DSH_READER_PRIVATE_ROOT, "reader-bridge-session.token") : undefined;
const DSH_READER_AUTH_HEADER = "x-dsh-reader-token";
const DSH_READER_ORIGIN = `http://${DSH_READER_BRIDGE_HOST}:${DSH_READER_BRIDGE_PORT}`;
function dshReaderConfiguredOrigin(value) {
  if (typeof value !== "string" || value.includes("*")) return undefined;
  try {
    const url = new URL(value);
    // `file:` serializes as the opaque Origin `null`; there is no exact
    // browser Origin to safely permit, so a file renderer must use a native
    // backend route rather than weakening this allowlist.
    if (url.protocol === "file:") return undefined;
    if (url.origin === "null") {
      return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(value) ? value : undefined;
    }
    return value === url.origin ? value : undefined;
  } catch {
    return undefined;
  }
}
export function dshReaderDesktopOriginFromArguments(args = process.argv, environmentOrigin = process.env.DSH_READER_DESKTOP_ORIGIN) {
  const index = Array.isArray(args) ? args.indexOf("--dsh-reader-desktop-origin") : -1;
  const fromArgument = index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] : undefined;
  return dshReaderConfiguredOrigin(fromArgument) ?? dshReaderConfiguredOrigin(environmentOrigin);
}
const DSH_READER_DESKTOP_ORIGIN = dshReaderDesktopOriginFromArguments();
const DSH_READER_ALLOWED_ORIGINS = new Set([
  DSH_READER_ORIGIN,
  ...(dshReaderConfiguredOrigin(DSH_READER_DESKTOP_ORIGIN) ? [DSH_READER_DESKTOP_ORIGIN] : []),
]);
// This is regenerated for every bridge process and is never put in state,
// papers, graph, or log records.  A native DSH plugin reads it from the
// private bridge directory and sends it only as a request header.
const DSH_READER_AUTH_TOKEN = randomBytes(32).toString("base64url");

let dshReaderBridgeServer;
let dshReaderStateCache;
let dshReaderStateLoadError;
const dshReaderOpenLog = [];

function dshReaderLog(message) {
  console.warn(`[reader-bridge] ${message}`);
}

function dshReaderStartupStatusDetail(detail) {
  if (Number.isInteger(detail)) return `status=${detail}`;
  const value = typeof detail?.code === "string" ? detail.code : detail;
  return typeof value === "string" && /^[A-Z0-9_]{1,32}$/.test(value) ? `code=${value}` : "status=1";
}

/** Reduce a failed SID subprocess to fixed labels; never retain its raw output. */
export function dshReaderStartupChildDiagnostics(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr
    : Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : "";
  const classes = [
    ["PS_INIT_ERROR", /initialization failed|failed to initialize|PowerShell.*cannot.*start/iu],
    ["PS_CONSTRAINED_LANGUAGE", /ConstrainedLanguage/iu],
    ["PS_SECURITY_ERROR", /PSSecurityException/iu],
    ["PS_ACCESS_ERROR", /UnauthorizedAccessException/iu],
    ["PS_PARSE_ERROR", /ParserError|ParseException/iu],
    ["PS_TYPE_ERROR", /TypeNotFound|Unable to find type/iu],
    ["PS_METHOD_ERROR", /MethodInvocationException/iu],
    ["PS_COMMAND_ERROR", /CommandNotFoundException|CouldNotAutoLoadModule/iu],
    ["PS_HOST_ERROR", /HostException|PSInvalidOperationException/iu],
  ];
  // PowerShell's public error identifier is separate from its message/data.
  // Require the entire metadata field to be an identifier; paths, SIDs,
  // token-shaped values and truncated prefixes cannot become a receipt code.
  const metadata = stderr.match(/^[ \t]*\+[ \t]*FullyQualifiedErrorId[ \t]*:[ \t]*([A-Za-z][A-Za-z0-9.]{0,95})(?=[ \t]*(?:,|$))/mu)?.[1];
  const errorId = metadata?.split(".").at(-1)?.toUpperCase();
  return {
    status: Number.isInteger(error?.status) ? error.status : -1,
    stderrPresent: stderr.length > 0,
    classCode: classes.find(([, pattern]) => pattern.test(stderr))?.[0] ?? "PS_UNCLASSIFIED",
    errorId: typeof errorId === "string" && /^[A-Z][A-Z0-9]{0,31}$/u.test(errorId) ? errorId : "UNKNOWN_ERRORID",
  };
}

/** Build one bounded, ASCII-only startup receipt without serializing error data. */
export function dshReaderStartupStatusLine(stage, detail = 0, timestamp = new Date(), pid = process.pid) {
  if (!DSH_READER_STARTUP_STAGES.has(stage) || !Number.isInteger(pid)) return undefined;
  const iso = timestamp instanceof Date && !Number.isNaN(timestamp.valueOf()) ? timestamp.toISOString() : undefined;
  if (iso === undefined) return undefined;
  return `${iso} pid=${pid} stage=${stage} ${dshReaderStartupStatusDetail(detail)}\n`;
}

/** Best-effort fixed-path diagnostic. It is called only from the executable entrypoint. */
export function dshReaderWriteStartupStatus(stage, detail = 0, target = DSH_READER_STARTUP_STATUS_FILE, timestamp = new Date(), pid = process.pid) {
  const line = dshReaderStartupStatusLine(stage, detail, timestamp, pid);
  if (line === undefined || typeof target !== "string" || target.length === 0) return false;
  const lineBytes = Buffer.byteLength(line, "ascii");
  if (lineBytes > DSH_READER_STARTUP_STATUS_MAX_BYTES) return false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const existingSize = existsSync(target) ? statSync(target).size : 0;
    if (existingSize + lineBytes > DSH_READER_STARTUP_STATUS_MAX_BYTES) writeFileSync(target, "", "ascii");
    appendFileSync(target, line, "ascii");
    return true;
  } catch {
    return false;
  }
}

function dshReaderLoadState() {
  if (dshReaderStateCache) return dshReaderStateCache;
  try {
    const parsed = JSON.parse(readFileSync(DSH_READER_STATE_FILE, "utf8"));
    dshReaderStateCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    // A present but corrupt state must never be treated as an empty state:
    // doing so could overwrite human read progress on the next mutation.
    dshReaderStateLoadError = error;
    dshReaderStateCache = {};
  }
  return dshReaderStateCache;
}

function dshReaderAtomicJsonWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function dshReaderSaveState(state = dshReaderLoadState()) {
  if (dshReaderStateLoadError) return false;
  try {
    mkdirSync(DSH_READER_ROOT, { recursive: true });
    dshReaderAtomicJsonWrite(DSH_READER_STATE_FILE, state);
    dshReaderStateCache = state;
    return true;
  } catch (error) {
    dshReaderLog(`failed to persist reader state: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// === DSH READER CURRENT (2026-09-16) ===
// "Current paper" state for the iframe-embedded reader: the DSH frontend polls
// GET /current instead of relying on a standalone reader window. POST /open
// always updates this state first; opening the reader window is now opt-in via
// body.target === "window". Persisted under the "current" key of
// reader-state.json, alongside the existing per-path read/unread map.
function dshReaderHasOpenableOriginal(paper) {
  return paper !== undefined && typeof paper.pdfEn === "string" && paper.pdfEn.length > 0;
}

/** A graph-recognized record without original bytes is not openable/writable. */
export function dshReaderOpenability(selection, papers = dshReaderLoadPapers(), graph = dshReaderLoadGraph()) {
  const paper = resolveCurrentPaper(selection, papers, graph);
  if (paper === undefined) {
    const value = selection && typeof selection === "object" && !Array.isArray(selection) ? selection : {};
    const candidates = [
      graph.paperById(typeof value.paper_id === "string" ? value.paper_id : value.paperId),
      graph.paperBySlug(typeof value.slug === "string" ? value.slug : value.readerSlug),
      graph.paperByPdf(typeof value.left === "string" ? value.left : value.pdf_en ?? value.pdfEn),
    ].filter((candidate) => candidate !== undefined);
    const unique = [...new Map(candidates.map((candidate) => [candidate.paperId ?? candidate.pdfEn, candidate])).values()];
    // A graph-recognized signal must never fall through to a legacy raw-path
    // write after strict consensus rejects a conflicting/forbidden asset.
    if (unique.length > 0) {
      const known = unique.length === 1 ? unique[0] : undefined;
      return known !== undefined && !dshReaderHasOpenableOriginal(known)
        ? { ok: false, error: "missing_original_asset", paper: known }
        : { ok: false, error: "selection_conflict", paper: known };
    }
  }
  if (paper !== undefined && !dshReaderHasOpenableOriginal(paper)) {
    return { ok: false, error: "missing_original_asset", paper };
  }
  return { ok: true, paper };
}

/**
 * Enrich a stored current selection for a read-only API response. CAS keeps
 * using dshReaderGetCurrent's raw persisted record; this function never
 * writes state or manufactures an original PDF from a translation asset.
 */
export function dshReaderBuildCurrentResponse(current, papers = dshReaderLoadPapers(), graph = dshReaderLoadGraph()) {
  const stored = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const paper = resolveCurrentPaper(stored, papers, graph);
  if (paper === undefined) return stored;
  const page = Number.isFinite(stored.page) ? stored.page : undefined;
  const payload = buildCurrentPayload(paper, { page, vaultName: DSH_READER_VAULT_NAME });
  const navigation = {
    ...(paper.paperId === undefined ? {} : { paper_id: paper.paperId }),
    ...(paper.slug === undefined ? {} : { slug: paper.slug }),
    ...(paper.title === undefined ? {} : { title: paper.title }),
    ...(paper.canonicalCard === undefined ? {} : {
      canonicalCard: paper.canonicalCard,
      obsidianUrl: `obsidian://open?vault=${encodeURIComponent(DSH_READER_VAULT_NAME)}&file=${encodeURIComponent(paper.canonicalCard)}`,
    }),
    ...(paper.paperId === undefined || paper.legacy === true ? {} : {
      networkViewUrl: `obsidian://paper-network?vault=${encodeURIComponent(DSH_READER_VAULT_NAME)}&node=${encodeURIComponent(paper.paperId)}`,
    }),
    ...(paper.context === undefined ? {} : { network: paper.context }),
    ...(page === undefined ? {} : { page }),
  };
  const response = payload ?? {
    ...navigation,
    ...(typeof paper.pdfZh === "string" && paper.pdfZh.length > 0 ? { right: paper.pdfZh } : {}),
    readable: false,
    error: "missing_original_asset",
  };
  for (const key of ["revision", "updatedAt"]) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) response[key] = stored[key];
  }
  return response;
}

function dshReaderSetCurrent(body) {
  const availability = dshReaderOpenability(body);
  const paper = availability.paper;
  if (!availability.ok) return undefined;
  const current = buildCurrentPayload(paper, {
    page: body.page,
    vaultName: DSH_READER_VAULT_NAME,
  }) ?? {
    left: body.left,
    ...(typeof body.right === "string" && body.right.length > 0 ? { right: body.right } : {}),
    ...(typeof body.title === "string" && body.title.length > 0 ? { title: body.title } : {}),
    ...(typeof body.paper_id === "string" && body.paper_id.length > 0 ? { paper_id: body.paper_id } : {}),
    ...(typeof body.slug === "string" && body.slug.length > 0 ? { slug: body.slug } : {}),
    ...(typeof body.canonicalCard === "string" && body.canonicalCard.length > 0 ? { canonicalCard: body.canonicalCard } : {}),
  };
  current.revision = randomBytes(18).toString("base64url");
  current.updatedAt = new Date().toISOString();
  const state = { ...dshReaderLoadState() };
  state.current = current;
  if (!dshReaderSaveState(state)) return undefined;
  return current;
}

function dshReaderGetCurrent() {
  const state = dshReaderLoadState();
  const current = state.current;
  return current && typeof current === "object" && !Array.isArray(current) ? current : {};
}
// === END DSH READER CURRENT ===

// === DSH READER PAPERS (2026-09-16) ===
// Paper list + slug selection endpoints for the DSH reader panel.
// GET /papers merges papers.json with the live read map from reader-state.json
// (keyed by pdfEn absolute path), reverse-looks-up the current paper's slug via
// current.left, and reports queue progress from reader-queue.json (optional).
// POST /select resolves a slug to its PDF paths and updates the shared current
// state through dshReaderSetCurrent — it never opens the reader window.
const DSH_READER_PAPERS_FILE = join(DSH_READER_ROOT, "papers.json");
const DSH_READER_QUEUE_FILE = join(DSH_READER_ROOT, "reader-queue.json");
const DSH_READER_GRAPH_FILE = join(DSH_READER_LIBRARY_ROOT, "_wiki", "network", "graph.json");
const DSH_READER_VAULT_NAME = "llm-wiki";
const DSH_READER_PAPERS_CACHE_TTL = 60 * 1000;
let dshReaderPapersCache;
let dshReaderGraphCache;

function dshReaderLoadPapers() {
  if (dshReaderPapersCache && Date.now() - dshReaderPapersCache.loadedAt < DSH_READER_PAPERS_CACHE_TTL) {
    return dshReaderPapersCache.papers;
  }
  let papers = [];
  try {
    const parsed = JSON.parse(readFileSync(DSH_READER_PAPERS_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.papers)) papers = parsed.papers;
  } catch (error) {
    dshReaderLog(`failed to load papers.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  dshReaderPapersCache = { loadedAt: Date.now(), papers };
  return papers;
}

function dshReaderAclSid(value) {
  const sid = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^S-\d+(?:-\d+)+$/u.test(sid) ? sid : "";
}

const DSH_READER_PINNED_WINDOWS_ROOT = "C:\\Windows";
const DSH_READER_PINNED_SYSTEM32 = join(DSH_READER_PINNED_WINDOWS_ROOT, "System32");
const DSH_READER_PINNED_PS_MODULES = join(DSH_READER_PINNED_SYSTEM32, "WindowsPowerShell", "v1.0", "Modules");
const DSH_READER_PINNED_SYSTEM_TOOLS = Object.freeze({
  powershell: join(DSH_READER_PINNED_SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
  icacls: join(DSH_READER_PINNED_SYSTEM32, "icacls.exe"),
  whoami: join(DSH_READER_PINNED_SYSTEM32, "whoami.exe"),
});

function dshReaderCanonicalWindowsRoot(systemRoot) {
  const candidate = typeof systemRoot === "string" ? systemRoot.trim() : "";
  if (candidate.length === 0) return DSH_READER_PINNED_WINDOWS_ROOT;
  const normalized = candidate.replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase();
  return normalized === "c:\\windows" ? DSH_READER_PINNED_WINDOWS_ROOT : undefined;
}

/** Resolve only the pinned, verified Windows ACL utilities. */
export function dshReaderWindowsSystemTools(systemRoot = process.env.SystemRoot) {
  return dshReaderCanonicalWindowsRoot(systemRoot) === undefined ? undefined : DSH_READER_PINNED_SYSTEM_TOOLS;
}

function dshReaderHasPinnedSystemTools(tools) {
  return tools?.powershell === DSH_READER_PINNED_SYSTEM_TOOLS.powershell
    && tools?.icacls === DSH_READER_PINNED_SYSTEM_TOOLS.icacls
    && tools?.whoami === DSH_READER_PINNED_SYSTEM_TOOLS.whoami;
}

/** Accept exactly the single quoted CSV record emitted by whoami /user /nh. */
export function dshReaderUserSidFromWhoami(output) {
  if (typeof output !== "string") return undefined;
  const match = output.trim().match(/^"(?:[^"\r\n]|"")*","(S-1-(?:\d+-)+\d+)"$/u);
  return match?.[1];
}

export function dshReaderCurrentUserSid(tools = dshReaderWindowsSystemTools(), childEnv = process.env) {
  if (!dshReaderHasPinnedSystemTools(tools)) return undefined;
  const output = execFileSync(tools.whoami, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  return dshReaderUserSidFromWhoami(output);
}

/** True only for a current-user-SID/SYSTEM-only explicit FullControl DACL. */
export function dshReaderPrivateAclIsTrusted(acl, currentUserSid) {
  if (!acl || typeof acl !== "object") return false;
  const userSid = dshReaderAclSid(currentUserSid);
  if (!userSid || dshReaderAclSid(acl.ownerSid) !== userSid || !Array.isArray(acl.access)) return false;
  const systemSid = "S-1-5-18";
  const allowed = new Set([userSid, systemSid]);
  let userFullControl = false;
  let systemFullControl = false;
  for (const entry of acl.access) {
    const entrySid = dshReaderAclSid(entry?.sid);
    if (!entry || typeof entry !== "object" || entry.isInherited !== false
      || entry.accessControlType !== "Allow" || !allowed.has(entrySid)) return false;
    if (entry.fileSystemRights !== "FullControl") return false;
    if (entrySid === userSid) userFullControl = true;
    if (entrySid === systemSid) systemFullControl = true;
  }
  return userFullControl && systemFullControl;
}

/** Parse only the basic file ACEs needed by the private user/SYSTEM policy. */
export function dshReaderPrivateAclFromSddl(output) {
  if (typeof output !== "string") return undefined;
  const descriptor = output.trim().match(/^O:([^:()\s]+)G:([^:()\s]+)D:((?:P|AI|AR)*)((?:\([^()\r\n]*\))+)$/u);
  if (!descriptor) return undefined;
  const ownerSid = descriptor[1] === "SY" ? "S-1-5-18" : dshReaderAclSid(descriptor[1]);
  if (!ownerSid) return undefined;
  const access = [];
  for (const text of descriptor[4].match(/\([^()]*\)/gu)) {
    const fields = text.slice(1, -1).split(";");
    if (fields.length !== 6 || !["A", "D"].includes(fields[0])
      || !/^(?:OI|CI|ID)*$/u.test(fields[1]) || fields[3] !== "" || fields[4] !== "") return undefined;
    const flags = fields[1].match(/.{2}/gu) ?? [];
    if (new Set(flags).size !== flags.length) return undefined;
    const sid = fields[5] === "SY" ? "S-1-5-18" : dshReaderAclSid(fields[5]);
    if (!sid || !/^(?:FA|0x(?:00)?1[fF]01[fF][fF])$/u.test(fields[2])) return undefined;
    access.push({ sid, accessControlType: fields[0] === "A" ? "Allow" : "Deny",
      fileSystemRights: "FullControl", isInherited: flags.includes("ID") });
  }
  return { ownerSid, access };
}

export function dshReaderReadPrivateAcl(path, tools = dshReaderWindowsSystemTools(), childEnv = process.env) {
  if (!dshReaderHasPinnedSystemTools(tools)) return undefined;
  // Built-in cmdlet/property access works within ConstrainedLanguage. The path
  // remains environment data, with no external script or .NET method invocation.
  const script = "$ErrorActionPreference='Stop'; (Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:DSH_READER_ACL_PATH).Sddl";
  const output = execFileSync(tools.powershell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    // Exclude inherited PowerShell 7/custom module roots and case aliases. Keep
    // the child's existing language/security policy; only OS cmdlets are loaded.
    env: { ...Object.fromEntries(Object.entries(childEnv).filter(([key]) => key.toLowerCase() !== "psmodulepath")),
      PSModulePath: DSH_READER_PINNED_PS_MODULES, DSH_READER_ACL_PATH: path },
  });
  return dshReaderPrivateAclFromSddl(output);
}

export function dshReaderAssertPrivateAcl(path, currentUserSid, tools = dshReaderWindowsSystemTools(), childEnv = process.env) {
  const acl = dshReaderReadPrivateAcl(path, tools, childEnv);
  return dshReaderPrivateAclIsTrusted(acl, currentUserSid);
}

export function dshReaderSetPrivateAcl(path, currentUserSid, directory, tools = dshReaderWindowsSystemTools(), childEnv = process.env) {
  if (!dshReaderHasPinnedSystemTools(tools)) throw new Error("untrusted Windows ACL executable paths");
  const userPrincipal = `*${currentUserSid}`;
  const systemPrincipal = "*S-1-5-18";
  const grant = directory ? `${userPrincipal}:(OI)(CI)F` : `${userPrincipal}:F`;
  const systemGrant = directory ? `${systemPrincipal}:(OI)(CI)F` : `${systemPrincipal}:F`;
  const options = { windowsHide: true, stdio: "ignore", env: childEnv };
  execFileSync(tools.icacls, [path, "/inheritance:r", "/grant:r", grant, "/grant:r", systemGrant,
    "/remove:g", "*S-1-5-32-545", "*S-1-5-11", "*S-1-1-0"], options);
  execFileSync(tools.icacls, [path, "/verify"], options);
}

function dshReaderWriteAuthToken(status = () => {}) {
  status("private_path_source", DSH_READER_SESSION_LOCATION.source);
  if (!DSH_READER_PRIVATE_ROOT || !DSH_READER_AUTH_FILE) {
    status("private_root_missing", 1);
    return false;
  }
  const tools = dshReaderWindowsSystemTools();
  status("trusted_tool", tools === undefined ? 1 : 0);
  if (tools === undefined) return false;
  let currentUserSid;
  try {
    currentUserSid = dshReaderCurrentUserSid(tools);
    status("sid_query", 0);
  } catch (error) {
    status("sid_query", error);
    const diagnostic = dshReaderStartupChildDiagnostics(error);
    status("sid_child_status", diagnostic.status);
    status("sid_stderr_present", diagnostic.stderrPresent ? 1 : 0);
    status("sid_error_class", diagnostic.classCode);
    status("sid_error_id", diagnostic.errorId);
    return false;
  }
  if (!currentUserSid) {
    status("sid_missing", 1);
    return false;
  }
  try {
    mkdirSync(DSH_READER_PRIVATE_ROOT, { recursive: true, mode: 0o700 });
    status("mkdir_private", 0);
  } catch (error) {
    status("mkdir_private", error);
    return false;
  }
  try {
    dshReaderSetPrivateAcl(DSH_READER_PRIVATE_ROOT, currentUserSid, true, tools);
    status("set_directory_acl", 0);
  } catch (error) {
    status("set_directory_acl", error);
    return false;
  }
  try {
    writeFileSync(DSH_READER_AUTH_FILE, `${DSH_READER_AUTH_TOKEN}\n`, { encoding: "utf8", mode: 0o600 });
    status("write_token", 0);
  } catch (error) {
    status("write_token", error);
    return false;
  }
  try {
    dshReaderSetPrivateAcl(DSH_READER_AUTH_FILE, currentUserSid, false, tools);
    status("set_token_acl", 0);
  } catch (error) {
    status("set_token_acl", error);
    return false;
  }
  try {
    if (!dshReaderAssertPrivateAcl(DSH_READER_PRIVATE_ROOT, currentUserSid, tools)) {
      status("verify_directory_acl", 1);
      return false;
    }
    status("verify_directory_acl", 0);
  } catch (error) {
    status("verify_directory_acl", error);
    return false;
  }
  try {
    if (!dshReaderAssertPrivateAcl(DSH_READER_AUTH_FILE, currentUserSid, tools)) {
      status("verify_token_acl", 1);
      return false;
    }
    status("verify_token_acl", 0);
  } catch (error) {
    status("verify_token_acl", error);
    return false;
  }
  return true;
}

export function dshReaderIsTrustedOrigin(origin) {
  return typeof origin === "string" && DSH_READER_ALLOWED_ORIGINS.has(origin);
}

export function dshReaderIsCrossSiteFetch(site) {
  return typeof site === "string" && site.toLowerCase() === "cross-site";
}

export function dshReaderHasTrustedHost(host) {
  return host === `${DSH_READER_BRIDGE_HOST}:${DSH_READER_BRIDGE_PORT}`;
}

function dshReaderRequestToken(req) {
  const header = req.headers[DSH_READER_AUTH_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const match = cookie.match(/(?:^|;\s*)dsh_reader_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function dshReaderHasValidToken(req) {
  const token = dshReaderRequestToken(req);
  if (token.length !== DSH_READER_AUTH_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(DSH_READER_AUTH_TOKEN));
}

function dshReaderSetCors(req, res) {
  const origin = req.headers.origin;
  if (dshReaderIsTrustedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${DSH_READER_AUTH_HEADER}`);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
}

function dshReaderLoadGraph() {
  if (dshReaderGraphCache && Date.now() - dshReaderGraphCache.loadedAt < DSH_READER_PAPERS_CACHE_TTL) {
    return dshReaderGraphCache.graph;
  }
  let graph = createPaperGraphAdapter(null);
  try {
    graph = createPaperGraphAdapter(JSON.parse(readFileSync(DSH_READER_GRAPH_FILE, "utf8")), {
      vaultRoot: DSH_READER_LIBRARY_ROOT,
    });
  } catch {
    // Graph deployment is staged separately; legacy current state stays usable.
  }
  dshReaderGraphCache = { loadedAt: Date.now(), graph };
  return graph;
}

function dshReaderResolvePaper(selection, papers = dshReaderLoadPapers()) {
  return resolveCurrentPaper(selection, papers, dshReaderLoadGraph());
}

function dshReaderQueueInfo(fallbackTotal) {
  try {
    const parsed = JSON.parse(readFileSync(DSH_READER_QUEUE_FILE, "utf8"));
    const order = Array.isArray(parsed.order) ? parsed.order : [];
    return {
      pointer: Number.isInteger(parsed.pointer) ? parsed.pointer : null,
      total: order.length > 0 ? order.length : fallbackTotal
    };
  } catch {
    return { pointer: null, total: fallbackTotal };
  }
}

function dshReaderHandlePapersList(res) {
  const papers = dshReaderLoadPapers();
  const graph = dshReaderLoadGraph();
  const resolver = prepareReaderPaperResolver(papers, graph);
  const state = dshReaderLoadState();
  const current = state.current && typeof state.current === "object" && !Array.isArray(state.current) ? state.current : null;
  const currentPaper = current ? resolver.resolveCurrent(current) : undefined;
  res.setHeader("Cache-Control", "no-store");
  dshReaderJson(res, 200, {
    papers: papers.map((row, index) => {
      // Reuse the prepared snapshot's normalized row.  Re-normalizing here
      // made this read-only response do another full pass after the resolver
      // had already built its collision-aware lookup maps.
      const legacy = resolver.entries[index];
      const paper = resolver.resolveCurrent({ paper_id: legacy.paperId, slug: legacy.slug, left: legacy.pdfEn });
      return {
        slug: paper?.slug ?? legacy.slug,
        paper_id: paper?.paperId,
        title: paper?.title ?? legacy.title,
        score: paper?.score ?? legacy.score,
        card: paper?.canonicalCard ?? (typeof row.card === "string" ? row.card : null),
        canonicalCard: paper?.canonicalCard,
        network: paper?.context,
        obsidianUrl: buildCurrentPayload(paper, { vaultName: DSH_READER_VAULT_NAME })?.obsidianUrl,
        scoreRange: row.projectRanking ? {
          lower: row.projectRanking.score_lower_bound,
          upper: row.projectRanking.score_upper_bound
        } : null,
        projectRank: Number.isInteger(row.projectRanking?.new_rank) ? row.projectRanking.new_rank : null,
        read: paper ? isLiveRead(paper, state) : legacy.read,
        hasZh: typeof (paper?.pdfZh ?? legacy.pdfZh) === "string"
      };
    }),
    current: {
      slug: currentPaper?.slug ?? null,
      paper_id: currentPaper?.paperId,
      canonicalCard: currentPaper?.canonicalCard,
      updatedAt: current && typeof current.updatedAt === "string" ? current.updatedAt : null,
    },
    queue: dshReaderQueueInfo(papers.length)
  });
}

function dshReaderQueueHash(order) {
  return createHash("sha256").update(JSON.stringify(order)).digest("hex");
}

function dshReaderLoadQueueSnapshot() {
  try {
    const queue = JSON.parse(readFileSync(DSH_READER_QUEUE_FILE, "utf8"));
    if (!queue || typeof queue !== "object" || Array.isArray(queue)
      || !Array.isArray(queue.order) || !queue.order.every((item) => typeof item === "string")
      || !Number.isInteger(queue.pointer) || queue.pointer < 0) return undefined;
    return { pointer: queue.pointer, order: queue.order, orderHash: dshReaderQueueHash(queue.order) };
  } catch {
    return undefined;
  }
}

function dshReaderCurrentRevision(current) {
  return typeof current?.revision === "string" && current.revision.length > 0
    ? current.revision
    : typeof current?.updatedAt === "string" ? current.updatedAt : undefined;
}

/** A queue pointer is meaningful only when it identifies the submitted next paper. */
export function dshReaderAdvanceMatchesQueue(next, nextPointer, order, papers, graph) {
  if (!Number.isInteger(nextPointer) || nextPointer < 0 || !Array.isArray(order)
    || nextPointer >= order.length || !next || typeof next !== "object") return false;
  const expected = resolveQueuePaper(order[nextPointer], papers, graph);
  const submitted = resolveCurrentPaper(next, papers, graph);
  if (!dshReaderHasOpenableOriginal(expected) || !dshReaderHasOpenableOriginal(submitted)
    || expected.pdfEn !== submitted.pdfEn) return false;
  // When both sides have a stable identity, it must agree too; a legacy queue
  // can still use a slug-only id as long as the resolved PDF is identical.
  return !expected.paperId || !submitted.paperId || expected.paperId === submitted.paperId;
}

/**
 * Commit the next selection and retained queue pointer as one synchronous
 * bridge operation. No await occurs between compare, queue write and state
 * write, so panel /select cannot be observed halfway through this transition.
 */
function dshReaderRecoverAdvanceJournal() {
  if (!existsSync(DSH_READER_ADVANCE_JOURNAL)) return true;
  try {
    const journal = JSON.parse(readFileSync(DSH_READER_ADVANCE_JOURNAL, "utf8"));
    if (!journal || journal.version !== 1 || !journal.priorQueue || !journal.nextQueue
      || typeof journal.expectedCurrentRevision !== "string" || typeof journal.nextRevision !== "string") return false;
    const queue = dshReaderLoadQueueSnapshot();
    const revision = dshReaderCurrentRevision(dshReaderLoadState().current);
    // State+queue already committed; only cleanup was interrupted.
    if (revision === journal.nextRevision && queue?.pointer === journal.nextQueue.pointer
      && queue.orderHash === dshReaderQueueHash(journal.nextQueue.order)) {
      unlinkSync(DSH_READER_ADVANCE_JOURNAL);
      return true;
    }
    // Queue was installed but current state did not commit. Restore only while
    // the original revision is still current, never over a human selection.
    if (revision === journal.expectedCurrentRevision) {
      dshReaderAtomicJsonWrite(DSH_READER_QUEUE_FILE, journal.priorQueue);
      unlinkSync(DSH_READER_ADVANCE_JOURNAL);
      return true;
    }
  } catch (error) {
    dshReaderLog(`advance journal recovery requires review: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  dshReaderLog("advance journal conflicts with newer current selection; bridge remains disabled");
  return false;
}

function dshReaderAdvanceCas(body) {
  const expected = body && typeof body === "object" ? body.expected : undefined;
  const next = body && typeof body === "object" ? body.next : undefined;
  const nextPointer = body && typeof body === "object" ? body.nextPointer : undefined;
  if (!expected || typeof expected.currentRevision !== "string" || !Number.isInteger(expected.queuePointer)
    || typeof expected.queueOrderHash !== "string" || !next || !Number.isInteger(nextPointer)) {
    return { ok: false, error: "invalid_advance_request" };
  }
  const stateBefore = dshReaderLoadState();
  const currentBefore = stateBefore.current;
  if (!currentBefore || dshReaderCurrentRevision(currentBefore) !== expected.currentRevision) {
    return { ok: false, error: "current_conflict", current: currentBefore ?? {} };
  }
  const queueBefore = dshReaderLoadQueueSnapshot();
  if (!queueBefore || queueBefore.pointer !== expected.queuePointer || queueBefore.orderHash !== expected.queueOrderHash) {
    return { ok: false, error: "queue_conflict", queue: queueBefore ?? null };
  }
  const papers = dshReaderLoadPapers();
  const graph = dshReaderLoadGraph();
  if (!dshReaderAdvanceMatchesQueue(next, nextPointer, queueBefore.order, papers, graph)
    || !dshReaderResolveIndexedPdfPath(next.left, next)
    || (typeof next.right === "string" && next.right.length > 0 && !dshReaderResolveIndexedPdfPath(next.right, next))) {
    return { ok: false, error: "queue_next_mismatch" };
  }
  const paper = resolveQueuePaper(queueBefore.order[nextPointer], papers, graph);
  const nextCurrent = buildCurrentPayload(paper, { page: next.page, vaultName: DSH_READER_VAULT_NAME });
  if (!nextCurrent) return { ok: false, error: "queue_next_mismatch" };
  nextCurrent.revision = randomBytes(18).toString("base64url");
  nextCurrent.updatedAt = new Date().toISOString();
  const stateAfter = { ...stateBefore, current: nextCurrent };
  const queueAfter = { pointer: nextPointer, order: queueBefore.order };
  try {
    dshReaderAtomicJsonWrite(DSH_READER_ADVANCE_JOURNAL, {
      version: 1, expectedCurrentRevision: expected.currentRevision,
      priorQueue: { pointer: queueBefore.pointer, order: queueBefore.order },
      nextQueue: queueAfter, nextRevision: nextCurrent.revision,
    });
    dshReaderAtomicJsonWrite(DSH_READER_QUEUE_FILE, queueAfter);
    dshReaderAtomicJsonWrite(DSH_READER_STATE_FILE, stateAfter);
    dshReaderStateCache = stateAfter;
    unlinkSync(DSH_READER_ADVANCE_JOURNAL);
    return { ok: true, current: nextCurrent, queue: { pointer: queueAfter.pointer, orderHash: dshReaderQueueHash(queueAfter.order) } };
  } catch (error) {
    // State was not deliberately restored: a newer human /select must never
    // be overwritten. Queue rollback is allowed only while the expected
    // current revision remains authoritative.
    let rollback = "not_attempted";
    if (dshReaderCurrentRevision(dshReaderLoadState().current) === expected.currentRevision) {
      try {
        dshReaderAtomicJsonWrite(DSH_READER_QUEUE_FILE, { pointer: queueBefore.pointer, order: queueBefore.order });
        rollback = "queue_restored";
      } catch {
        rollback = "queue_restore_failed";
      }
    } else {
      rollback = "current_changed_no_restore";
    }
    return { ok: false, error: "advance_persist_failed", recovery: rollback,
      message: error instanceof Error ? error.message : String(error) };
  }
}

function dshReaderHandleSelect(body, res) {
  const slug = typeof body.slug === "string" ? body.slug : "";
  const paperId = typeof body.paper_id === "string" ? body.paper_id : "";
  if (slug.length === 0 && paperId.length === 0) {
    dshReaderJson(res, 400, { ok: false, error: "paper_selector_required" });
    return;
  }
  const papers = dshReaderLoadPapers();
  const paper = dshReaderResolvePaper({ paper_id: paperId, slug }, papers);
  if (!paper) {
    const candidates = papers
      .filter((entry) => typeof entry.slug === "string" && entry.slug.includes(slug))
      .slice(0, 5)
      .map((entry) => entry.slug);
    dshReaderJson(res, 200, { ok: false, error: "not_found", candidates });
    return;
  }
  if (typeof paper.pdfEn !== "string" || paper.pdfEn.length === 0) {
    dshReaderJson(res, 200, { ok: false, error: "missing_original_asset", canonicalCard: paper.canonicalCard });
    return;
  }
  const current = dshReaderSetCurrent({
    left: paper.pdfEn,
    right: paper.pdfZh,
    page: Number.isFinite(body.page) ? body.page : 1,
    title: paper.title,
    paper_id: paper.paperId,
    slug: paper.slug,
    canonicalCard: paper.canonicalCard,
  });
  if (!current) {
    dshReaderJson(res, 503, { ok: false, error: "state_persistence_unavailable" });
    return;
  }
  dshReaderJson(res, 200, { ok: true, current });
}
// === END DSH READER PAPERS ===

function dshReaderJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function dshReaderReadBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > DSH_READER_BODY_LIMIT) {
        rejectBody(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

/** Exact membership check for PDF paths advertised by the paper index. */
export function dshReaderMatchesIndexedPdfAsset(rawPath, indexedPaths) {
  if (typeof rawPath !== "string" || !rawPath.toLowerCase().endsWith(".pdf")) return false;
  const requested = resolve(rawPath).toLowerCase();
  return indexedPaths.some((candidate) => typeof candidate === "string"
    && candidate.toLowerCase().endsWith(".pdf")
    && resolve(candidate).toLowerCase() === requested);
}

export function dshReaderResolveIndexedPdfPathFor(rawPath, selection = undefined, options = {}) {
  const libraryRoot = options.libraryRoot ?? DSH_READER_LIBRARY_ROOT;
  const papers = options.papers ?? dshReaderLoadPapers();
  const graph = options.graph ?? dshReaderLoadGraph();
  const realpath = options.realpath ?? realpathSync;
  const resolvePath = options.resolvePath ?? resolve;
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  let resolved;
  try {
    const root = realpath(libraryRoot).toLowerCase();
    resolved = realpath(resolvePath(rawPath)).toLowerCase();
    if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  } catch {
    return null;
  }
  // Graph availability is authoritative before the legacy-index fast path.
  // `assetAvailabilityFor` is prepared once with the graph and false wins
  // across raw_path, path, and vault-resolved aliases.
  if (graph.assetAvailabilityFor?.(rawPath) === false || graph.assetAvailabilityFor?.(resolved) === false) return null;
  const indexedPaths = papers.flatMap((row, index) => {
    const paper = normalizeReaderEntry(row, index);
    return [paper.pdfEn, paper.pdfZh].filter((path) => typeof path === "string");
  });
  if (dshReaderMatchesIndexedPdfAsset(rawPath, indexedPaths)) return resolved;
  // Graph-only canonical assets are allowed only when the same submitted
  // stable selection resolves to that exact graph paper, after realpath has
  // already proved the file remains inside the vault.
  const graphPaper = selection === undefined ? undefined
    : resolveCurrentPaper(selection, papers, graph);
  const graphAssets = graphPaper === undefined ? [] : [graphPaper.pdfEn, graphPaper.pdfZh]
  return dshReaderMatchesIndexedPdfAsset(rawPath, graphAssets) ? resolved : null;
}

function dshReaderResolveIndexedPdfPath(rawPath, selection = undefined) {
  return dshReaderResolveIndexedPdfPathFor(rawPath, selection);
}

export function dshReaderRequestIsAuthorized({ host, origin, fetchSite, hasValidToken, bootstrap }) {
  if (!dshReaderHasTrustedHost(host) || dshReaderIsCrossSiteFetch(fetchSite)) return false;
  // Bootstrap has no private header yet; it is only granted to the explicitly
  // configured desktop origin. A missing Origin is not proof of locality.
  if (bootstrap) return dshReaderIsTrustedOrigin(origin) || hasValidToken;
  if (!hasValidToken) return false;
  return origin === undefined || dshReaderIsTrustedOrigin(origin);
}

function dshReaderAuthorizedRequest(req, pathname) {
  return dshReaderRequestIsAuthorized({
    host: req.headers.host,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    hasValidToken: dshReaderHasValidToken(req),
    bootstrap: pathname === "/" || pathname === "/bootstrap",
  });
}

function dshReaderContentType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json; charset=utf-8";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

// In the Electron patch this opens/focuses a real BrowserWindow; here we open
// the reader URL in the system default browser as the independent window.
function openDshReaderWindow(options) {
  const params = new URLSearchParams();
  params.set("left", options.left);
  if (options.right) params.set("right", options.right);
  if (Number.isFinite(options.page)) params.set("page", String(options.page));
  const url = `http://${DSH_READER_BRIDGE_HOST}:${DSH_READER_BRIDGE_PORT}/?${params.toString()}`;
  dshReaderOpenLog.push({ url, title: options.title });
  dshReaderLog(`open reader window url=${url} title=${options.title ?? ""}`);
  try {
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => dshReaderLog(`open reader window spawn error: ${error.message}`));
    child.unref();
  } catch (error) {
    dshReaderLog(`open reader window failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dshReaderSamePaper(left, right) {
  if (!left || !right) return false;
  if (typeof left.paperId === "string" && typeof right.paperId === "string") {
    return left.paperId === right.paperId;
  }
  return typeof left.pdfEn === "string" && left.pdfEn === right.pdfEn;
}

function dshReaderExactThinkingQuery(query, paper) {
  const normalized = typeof query === "string" ? query.trim().toLocaleLowerCase() : "";
  if (normalized.length === 0 || !paper) return false;
  return [paper.paperId, paper.slug, paper.title, paper.canonicalCard]
    .some((value) => typeof value === "string" && value.trim().toLocaleLowerCase() === normalized);
}

/**
 * Resolve a direct reader write-back against the live current selection.
 * A browser request cannot use a title substring as write authority: every
 * supplied stable signal and the observed revision must still name `current`.
 *
 * This is exported for a no-write fixture: callers can inspect the exact
 * append_thinking.py arguments without spawning Python or touching a card.
 */
export function dshReaderBuildThinkingCommand(body, current, papers, graph, options = {}) {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const expectedRevision = typeof value.expectedRevision === "string" ? value.expectedRevision : undefined;
  const currentRevision = dshReaderCurrentRevision(current);
  if (expectedRevision === undefined || currentRevision === undefined || expectedRevision !== currentRevision) {
    return { ok: false, error: "current_revision_conflict" };
  }
  const paperId = typeof value.paper_id === "string" && value.paper_id.trim() !== "" ? value.paper_id : undefined;
  const left = typeof value.left === "string" && value.left.trim() !== "" ? value.left : undefined;
  const slug = typeof value.slug === "string" && value.slug.trim() !== "" ? value.slug : undefined;
  if (paperId === undefined || left === undefined) return { ok: false, error: "selection_identity_required" };

  const resolvedCurrent = resolveCurrentPaper(current, papers, graph);
  const resolvedRequested = resolveCurrentPaper({ paper_id: paperId, left, ...(slug === undefined ? {} : { slug }) }, papers, graph);
  if (!resolvedCurrent || !resolvedRequested || !dshReaderSamePaper(resolvedCurrent, resolvedRequested)
    || !dshReaderExactThinkingQuery(value.query, resolvedCurrent)) {
    return { ok: false, error: "selection_conflict" };
  }

  const question = typeof value.question === "string" && value.question.length > 0 ? value.question : undefined;
  const script = typeof options.script === "string" && options.script.length > 0
    ? options.script : DSH_READER_THINKING_SCRIPT;
  const source = typeof options.source === "string" && options.source.length > 0 ? options.source : "DSH Reader";
  const args = [script];
  if (graph?.graphAvailable === true) {
    if (resolvedCurrent.legacy === true || typeof resolvedCurrent.canonicalCard !== "string" || resolvedCurrent.canonicalCard.length === 0) {
      return { ok: false, error: "canonical_card_unavailable" };
    }
    // The canonical vault-relative card, rather than a fuzzy query, is the
    // only write target for a V1 graph selection.
    args.push(resolvedCurrent.paperId, "--stdin", "--card", resolvedCurrent.canonicalCard);
  } else {
    // Legacy deployments retain compatibility only for an exact current
    // slug/title, never the previous substring-search behavior.
    const target = typeof resolvedCurrent.slug === "string" && resolvedCurrent.slug.length > 0
      ? resolvedCurrent.slug : resolvedCurrent.title;
    if (typeof target !== "string" || target.length === 0) return { ok: false, error: "legacy_target_unavailable" };
    args.push(target, "--stdin");
  }
  if (question !== undefined) args.push("--question", question);
  args.push("--source", source);
  return {
    ok: true,
    args,
    text: typeof value.text === "string" ? value.text : "",
    paper: resolvedCurrent,
  };
}

function dshReaderHandleThinking(body, res) {
  const command = dshReaderBuildThinkingCommand(body, dshReaderGetCurrent(), dshReaderLoadPapers(), dshReaderLoadGraph());
  if (!command.ok) {
    const status = command.error === "current_revision_conflict" || command.error === "selection_conflict" ? 409 : 400;
    dshReaderJson(res, status, { ok: false, error: command.error });
    return;
  }
  let child;
  try {
    child = spawn(DSH_READER_PYTHON_CMD, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", LLM_WIKI_VAULT: DSH_READER_LIBRARY_ROOT },
    });
  } catch (error) {
    dshReaderJson(res, 500, { ok: false, message: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (ok, message) => {
    if (settled) return;
    settled = true;
    dshReaderJson(res, ok ? 200 : 500, { ok, message });
  };
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => finish(false, `spawn failed: ${error.message}`));
  child.on("close", (code) => {
    const message = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
    finish(code === 0, message || `append_thinking.py exited with code ${code}`);
  });
  child.stdin.on("error", () => {});
  child.stdin.write(command.text, "utf8");
  child.stdin.end();
}

export async function handleDshReaderRequest(req, res) {
  try {
    const url = new URL(req.url ?? "/", `http://${DSH_READER_BRIDGE_HOST}:${DSH_READER_BRIDGE_PORT}`);
    dshReaderSetCors(req, res);
    if (req.method === "OPTIONS") {
      if (!dshReaderHasTrustedHost(req.headers.host) || !dshReaderIsTrustedOrigin(req.headers.origin) || dshReaderIsCrossSiteFetch(req.headers["sec-fetch-site"])) {
        dshReaderJson(res, 403, { ok: false, message: "forbidden" });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (!dshReaderAuthorizedRequest(req, url.pathname)) {
      dshReaderJson(res, 403, { ok: false, message: "bridge session authorization required" });
      return;
    }
    // Narrow browser bootstrap: the exact configured DSH origin receives an
    // HttpOnly bridge cookie. It exposes no token in JavaScript or response body.
    if (req.method === "POST" && url.pathname === "/bootstrap") {
      res.setHeader("Set-Cookie", `dsh_reader_session=${encodeURIComponent(DSH_READER_AUTH_TOKEN)}; HttpOnly; SameSite=Strict; Path=/`);
      dshReaderJson(res, 204, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/obsidian") {
      let body;
      try { body = JSON.parse(await dshReaderReadBody(req)); } catch {
        dshReaderJson(res, 400, { ok: false, error: "invalid_body" });
        return;
      }
      const paper = resolveCurrentPaper(dshReaderGetCurrent(), dshReaderLoadPapers(), dshReaderLoadGraph());
      const result = readerOpenObsidian(body, paper);
      dshReaderJson(res, result.ok ? 200 : result.error === "navigation_not_current" ? 409 : 502, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      const readerHtml = join(DSH_READER_ROOT, "reader.html");
      if (!existsSync(readerHtml)) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("reader.html is not installed yet");
        return;
      }
      // Cookie authenticates PDF.js asset requests, which cannot attach a
      // custom header. The injected value is used by same-origin fetch calls.
      res.setHeader("Set-Cookie", `dsh_reader_session=${encodeURIComponent(DSH_READER_AUTH_TOKEN)}; HttpOnly; SameSite=Strict; Path=/`);
      const frameAncestors = [...DSH_READER_ALLOWED_ORIGINS].map((origin) => origin).join(" ");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors ${frameAncestors}`,
      });
      const html = readFileSync(readerHtml, "utf8");
      res.end(html.replace("<head>", `<head><script>window.__DSH_READER_PARENT_ORIGIN__=${JSON.stringify(DSH_READER_DESKTOP_ORIGIN ?? "")};</script>`));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
      const relativePath = decodeURIComponent(url.pathname.slice("/vendor/".length));
      const vendorRoot = join(DSH_READER_ROOT, "vendor");
      const filePath = resolve(join(vendorRoot, relativePath));
      if (filePath !== vendorRoot && !filePath.startsWith(vendorRoot + sep)) {
        dshReaderJson(res, 403, { ok: false, message: "forbidden" });
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        dshReaderJson(res, 404, { ok: false, message: "not found" });
        return;
      }
      res.writeHead(200, { "Content-Type": dshReaderContentType(filePath) });
      createReadStream(filePath).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/file") {
      const filePath = dshReaderResolveIndexedPdfPath(url.searchParams.get("path") ?? "", dshReaderGetCurrent());
      if (!filePath) {
        dshReaderJson(res, 403, { ok: false, message: "path is not an indexed paper PDF" });
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        dshReaderJson(res, 404, { ok: false, message: "not found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": statSync(filePath).size
      });
      createReadStream(filePath).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      const state = dshReaderLoadState();
      const key = url.searchParams.get("path") ?? "";
      const entry = state[key];
      dshReaderJson(res, 200, { path: key, read: entry === true, state: entry ?? null });
      return;
    }

    if (req.method === "GET" && url.pathname === "/read-state") {
      const state = dshReaderLoadState();
      const overlay = Object.fromEntries(Object.entries(state).filter(([key, value]) => key !== "current" && typeof value === "boolean"));
      dshReaderJson(res, 200, overlay);
      return;
    }
    // === DSH READER PAPERS (2026-09-16) ===
    if (req.method === "GET" && url.pathname === "/papers") {
      dshReaderHandlePapersList(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/select") {
      let body = {};
      try {
        body = JSON.parse(await dshReaderReadBody(req));
      } catch {
        dshReaderJson(res, 400, { ok: false, error: "invalid_body" });
        return;
      }
      dshReaderHandleSelect(body, res);
      return;
    }
    // === END DSH READER PAPERS ===
    // === DSH READER CURRENT (2026-09-16) ===
    if (req.method === "GET" && url.pathname === "/current") {
      dshReaderJson(res, 200, dshReaderBuildCurrentResponse(dshReaderGetCurrent()));
      return;
    }
    // === END DSH READER CURRENT ===
    if (req.method === "POST" && url.pathname === "/validate-current") {
      let body = {};
      try { body = JSON.parse(await dshReaderReadBody(req)); } catch {
        dshReaderJson(res, 400, { ok: false, error: "invalid_body" });
        return;
      }
      const current = dshReaderGetCurrent();
      const expected = body && typeof body === "object" ? body.expected : undefined;
      const queue = dshReaderLoadQueueSnapshot();
      const valid = expected && typeof expected.currentRevision === "string"
        && expected.currentRevision === dshReaderCurrentRevision(current)
        && Number.isInteger(expected.queuePointer) && expected.queuePointer === queue?.pointer
        && typeof expected.queueOrderHash === "string" && expected.queueOrderHash === queue?.orderHash;
      dshReaderJson(res, valid ? 200 : 409, valid
        ? { ok: true, receipt: { currentRevision: dshReaderCurrentRevision(current), queuePointer: queue.pointer, queueOrderHash: queue.orderHash } }
        : { ok: false, error: "current_or_queue_conflict" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/advance") {
      let body = {};
      try { body = JSON.parse(await dshReaderReadBody(req)); } catch {
        dshReaderJson(res, 400, { ok: false, error: "invalid_body" });
        return;
      }
      const result = dshReaderAdvanceCas(body);
      dshReaderJson(res, result.ok ? 200 : result.error === "current_conflict" || result.error === "queue_conflict" ? 409 : 500, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/open") {
      let body = {};
      try {
        body = JSON.parse(await dshReaderReadBody(req));
      } catch {
        dshReaderJson(res, 400, { ok: false, message: "invalid JSON body" });
        return;
      }
      if (typeof body.left !== "string" || body.left.length === 0) {
        dshReaderJson(res, 400, { ok: false, message: "left is required" });
        return;
      }
      const availability = dshReaderOpenability(body);
      if (!availability.ok) {
        dshReaderJson(res, 409, {
          ok: false,
          error: availability.error,
          ...(availability.paper?.canonicalCard === undefined ? {} : { canonicalCard: availability.paper.canonicalCard }),
        });
        return;
      }
      if (!dshReaderResolveIndexedPdfPath(body.left, body)
        || (typeof body.right === "string" && body.right.length > 0 && !dshReaderResolveIndexedPdfPath(body.right, body))) {
        dshReaderJson(res, 403, { ok: false, message: "open paths must be indexed paper PDFs" });
        return;
      }
      // === DSH READER CURRENT (2026-09-16) ===
      // Always update the current-paper state first; only open/focus the
      // standalone reader window when explicitly requested (v1 behavior).
      if (!dshReaderSetCurrent(body)) {
        dshReaderJson(res, 503, { ok: false, error: "state_persistence_unavailable" });
        return;
      }
      if (body.target === "window") {
        openDshReaderWindow({
          left: body.left,
          right: typeof body.right === "string" && body.right.length > 0 ? body.right : void 0,
          page: Number.isFinite(body.page) ? body.page : void 0,
          title: typeof body.title === "string" && body.title.length > 0 ? body.title : void 0
        });
      }
      // === END DSH READER CURRENT ===
      dshReaderJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/thinking") {
      let body = {};
      try {
        body = JSON.parse(await dshReaderReadBody(req));
      } catch {
        dshReaderJson(res, 400, { ok: false, message: "invalid JSON body" });
        return;
      }
      dshReaderHandleThinking(body, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/read") {
      let body = {};
      try {
        body = JSON.parse(await dshReaderReadBody(req));
      } catch {
        dshReaderJson(res, 400, { ok: false, message: "invalid JSON body" });
        return;
      }
      if (typeof body.path !== "string" || body.path.length === 0 || typeof body.read !== "boolean") {
        dshReaderJson(res, 400, { ok: false, message: "path (string) and read (boolean) are required" });
        return;
      }
      if (!dshReaderResolveIndexedPdfPath(body.path, dshReaderGetCurrent())) {
        dshReaderJson(res, 403, { ok: false, message: "read path must be an indexed paper PDF" });
        return;
      }
      const state = dshReaderLoadState();
      state[body.path] = body.read;
      if (!dshReaderSaveState(state)) {
        dshReaderJson(res, 503, { ok: false, error: "state_persistence_unavailable" });
        return;
      }
      dshReaderJson(res, 200, { ok: true, path: body.path, read: body.read });
      return;
    }
    dshReaderJson(res, 404, { ok: false, message: "unknown endpoint" });
  } catch (error) {
    dshReaderLog(`request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    if (!res.headersSent) dshReaderJson(res, 500, { ok: false, message: "internal error" });
    else res.destroy();
  }
}

function startDshReaderBridge(status = () => {}) {
  if (dshReaderBridgeServer) return true;
  const journalRecovered = dshReaderRecoverAdvanceJournal();
  status("journal_recovery", journalRecovered ? 0 : 1);
  if (!journalRecovered) {
    dshReaderLog("reader bridge disabled pending advance journal recovery");
    return false;
  }
  if (!dshReaderWriteAuthToken(status)) {
    dshReaderLog("reader bridge disabled because its auth session could not be created");
    return false;
  }
  const server = createServer((req, res) => {
    void handleDshReaderRequest(req, res);
  });
  server.on("error", (error) => {
    status("listener_error", error);
    dshReaderLog(`bridge server unavailable (${dshReaderStartupStatusDetail(error)}); reader bridge disabled for this session`);
    dshReaderBridgeServer = void 0;
    process.exitCode = 1;
    try {
      server.close();
    } catch {
    }
  });
  server.listen(DSH_READER_BRIDGE_PORT, DSH_READER_BRIDGE_HOST, () => {
    status("listener_ready", 0);
    dshReaderLog(`reader bridge listening on http://${DSH_READER_BRIDGE_HOST}:${DSH_READER_BRIDGE_PORT}`);
  });
  dshReaderBridgeServer = server;
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const status = (stage, detail) => dshReaderWriteStartupStatus(stage, detail);
  status("main_entry", 0);
  if (!startDshReaderBridge(status)) process.exitCode = 1;
}
