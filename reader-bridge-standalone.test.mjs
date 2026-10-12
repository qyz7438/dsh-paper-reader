import {
  dshReaderIsCrossSiteFetch,
  dshReaderIsTrustedOrigin,
  dshReaderHasTrustedHost,
  dshReaderMatchesIndexedPdfAsset,
  dshReaderRequestIsAuthorized,
  dshReaderAdvanceMatchesQueue,
  dshReaderBuildThinkingCommand,
  dshReaderBuildCurrentResponse,
  dshReaderDesktopOriginFromArguments,
  dshReaderOpenability,
  dshReaderAssertPrivateAcl,
  dshReaderCurrentUserSid,
  dshReaderPrivateAclIsTrusted,
  dshReaderPrivateAclFromSddl,
  dshReaderReadPrivateAcl,
  dshReaderResolveIndexedPdfPathFor,
  dshReaderSetPrivateAcl,
  dshReaderStartupChildDiagnostics,
  dshReaderStartupStatusLine,
  dshReaderWriteStartupStatus,
  dshReaderWindowsSystemTools,
  dshReaderUserSidFromWhoami,
  handleDshReaderRequest,
} from './reader-bridge-standalone.mjs'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function withoutPath(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'))
}

function systemOnlyPath(env) {
  const root = typeof env.SystemRoot === 'string' && env.SystemRoot.length > 0 ? env.SystemRoot : 'C:/Windows'
  return { ...withoutPath(env), Path: join(root, 'System32') }
}

const knownPdf = 'E:/CLI/llm-wiki/pdfs/paper.pdf'
const sameOrigin = 'http://127.0.0.1:58812'
const trustedHost = '127.0.0.1:58812'
const queueIdentityPapers = [
  { paper_id: 'paper:a', slug: 'a', title: 'A', pdfEn: 'E:/fake/a.pdf' },
  { paper_id: 'paper:b', slug: 'b', title: 'B', pdfEn: 'E:/fake/b.pdf' },
  { paper_id: 'paper:c', slug: 'c', title: 'C', pdfEn: 'E:/fake/c.pdf' },
]
const queueIdentityGraph = { schema_version: 'paper-network-v1', nodes: queueIdentityPapers.map((paper) => ({
  id: paper.paper_id, type: paper.paper_id === 'paper:b' ? 'topic' : 'paper', label: paper.title,
  card: `_wiki/references/${paper.slug}.md`,
  metadata: { paper_id: paper.paper_id, reader_slugs: [paper.slug], pdf_en: paper.pdfEn },
})) }
const { createPaperGraphAdapter } = await import('./dsh-reader/paper-graph-adapter.js')
const thinkingGraph = createPaperGraphAdapter(queueIdentityGraph)
const translationOnlyPapers = [{ paper_id: 'paper:translation-only', slug: 'translation-only', title: 'Translation only', pdfEn: 'E:/fake/translation-only_镜像.pdf' }]
const translationOnlyGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:translation-only', type: 'paper', label: 'Translation only', card: '_wiki/references/translation-only.md',
    metadata: { paper_id: 'paper:translation-only', reader_slugs: ['translation-only'], pdf_en: [], pdf_zh: ['E:/fake/translation-only_镜像.pdf'],
      assets: [{ path: 'pdfs/translation-only_镜像.pdf', raw_path: 'E:/fake/translation-only_镜像.pdf', role: 'translation' }] },
  }],
})
const translationOnlyCurrent = { paper_id: 'paper:translation-only', slug: 'translation-only', left: 'E:/fake/translation-only_镜像.pdf', revision: 'translation-r1', updatedAt: '2026-10-12T00:00:00.000Z' }
const translationOnlyStateSnapshot = JSON.stringify(translationOnlyCurrent)
const translationOnlyResponse = dshReaderBuildCurrentResponse(translationOnlyCurrent, translationOnlyPapers, translationOnlyGraph)
const staleMetadataPapers = [{ paper_id: 'paper:stale-unclassified', slug: 'stale-unclassified', title: 'Stale unclassified', pdfEn: 'E:/vault/stale-metadata.pdf' }]
const staleMetadataGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:stale-unclassified', type: 'paper', label: 'Stale unclassified', card: '_wiki/references/stale-unclassified.md',
    metadata: {
      paper_id: 'paper:stale-unclassified', reader_slugs: ['stale-unclassified'], pdf_en: ['pdfs/stale-metadata.pdf'],
      assets: [{ path: 'pdfs/stale-metadata.pdf', raw_path: 'E:/vault/stale-metadata.pdf', role: 'unclassified', recorded_role: 'original' }],
    },
  }],
}, { vaultRoot: 'E:/vault' })
const staleMetadataOpen = dshReaderOpenability({
  paper_id: 'paper:stale-unclassified', slug: 'stale-unclassified', left: 'E:/vault/stale-metadata.pdf',
}, staleMetadataPapers, staleMetadataGraph)
const thinkingCurrent = { paper_id: 'paper:b', slug: 'b', left: 'E:/fake/b.pdf', revision: 'current-revision' }
const thinkingRequest = {
  paper_id: 'paper:b', slug: 'b', left: 'E:/fake/b.pdf', query: 'b',
  expectedRevision: 'current-revision', text: 'selected evidence', question: 'What changes?',
}
const thinkingCommand = dshReaderBuildThinkingCommand(thinkingRequest, thinkingCurrent, queueIdentityPapers, thinkingGraph, {
  script: 'E:/fixture/append_thinking.py', source: 'fixture-reader',
})
const checks = [
  ['failed SID diagnostics expose only numeric status, presence and a fixed class',
    (() => {
      const classified = dshReaderStartupChildDiagnostics({ status: 1, stderr: Buffer.from('ParserError secret SID environment text') });
      const unknown = dshReaderStartupChildDiagnostics({ status: 'bad', stderr: 'secret SID environment text', message: 'not logged', code: 'SECRET_CODE' });
      return JSON.stringify(classified) === JSON.stringify({ status: 1, stderrPresent: true, classCode: 'PS_PARSE_ERROR', errorId: 'UNKNOWN_ERRORID' })
        && dshReaderStartupChildDiagnostics({ stderr: 'MethodInvocationNotSupportedInConstrainedLanguage' }).classCode === 'PS_CONSTRAINED_LANGUAGE'
        && dshReaderStartupChildDiagnostics({ stderr: 'PSSecurityException' }).classCode === 'PS_SECURITY_ERROR'
        && dshReaderStartupChildDiagnostics({ stderr: 'UnauthorizedAccessException' }).classCode === 'PS_ACCESS_ERROR'
        && dshReaderStartupChildDiagnostics({ stderr: ' + FullyQualifiedErrorId : System.Management.Automation.ParameterBindingException,script.ps1' }).errorId === 'PARAMETERBINDINGEXCEPTION'
        && dshReaderStartupChildDiagnostics({ stderr: ' + FullyQualifiedErrorId : S-1-5-21-1234' }).errorId === 'UNKNOWN_ERRORID'
        && dshReaderStartupChildDiagnostics({ stderr: ' + FullyQualifiedErrorId : ' + 'a'.repeat(43) }).errorId === 'UNKNOWN_ERRORID'
        && dshReaderStartupChildDiagnostics({ stderr: 'private prose FullyQualifiedErrorId : SECRET123' }).errorId === 'UNKNOWN_ERRORID'
        && JSON.stringify(unknown) === JSON.stringify({ status: -1, stderrPresent: true, classCode: 'PS_UNCLASSIFIED', errorId: 'UNKNOWN_ERRORID' })
        && JSON.stringify(dshReaderStartupChildDiagnostics({})).includes('"stderrPresent":false');
    })()],
  ['Windows ACL tools are pinned to C:/Windows and reject poisoned SystemRoot values',
    (() => {
      const normal = dshReaderWindowsSystemTools('c:/WINDOWS\\')
      const rejected = ['E:/evil', '\\\\server\\share', 'Windows', 'C:/Windows/../evil']
        .every((systemRoot) => dshReaderWindowsSystemTools(systemRoot) === undefined)
      return typeof normal?.powershell === 'string' && typeof normal?.icacls === 'string' && typeof normal?.whoami === 'string'
        && normal.powershell.toLowerCase().includes('c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe')
        && normal.icacls.toLowerCase().endsWith('c:\\windows\\system32\\icacls.exe')
        && normal.whoami.toLowerCase().endsWith('c:\\windows\\system32\\whoami.exe') && rejected
    })()],
  ['whoami parsing accepts one quoted CSV row and rejects malformed or multiple identities',
    dshReaderUserSidFromWhoami('"domain\\name,with""quote","S-1-5-21-1-2-3-1001"\r\n') === 'S-1-5-21-1-2-3-1001'
    && ['"name","not-a-sid"', 'name,S-1-5-21-1-2-3-1001', '"name","S-1-5-21-1-2-3-1001","extra"',
      '"name","S-1-5-21-1-2-3-1001"\n"other","S-1-5-18"'].every(value => dshReaderUserSidFromWhoami(value) === undefined)],
  ['SDDL parser preserves the exact private owner, rights, type and inheritance gate',
    (() => {
      const owner = 'S-1-5-21-1-2-3-1001'
      const prefix = `O:${owner}G:${owner}D:PAI`
      const valid = `${prefix}(A;OICI;FA;;;SY)(A;OICI;0x001f01ff;;;${owner})`
      return dshReaderPrivateAclIsTrusted(dshReaderPrivateAclFromSddl(valid), owner)
        && ['ID', 'OICIID'].every(flags => !dshReaderPrivateAclIsTrusted(dshReaderPrivateAclFromSddl(`${prefix}(A;${flags};FA;;;SY)(A;;FA;;;${owner})`), owner))
        && !dshReaderPrivateAclIsTrusted(dshReaderPrivateAclFromSddl(`${prefix}(D;;FA;;;SY)(A;;FA;;;${owner})`), owner)
        && !dshReaderPrivateAclIsTrusted(dshReaderPrivateAclFromSddl(valid.replace(`O:${owner}`, 'O:S-1-5-18')), owner)
        && ['IO', 'OIIO', 'FA', 'OIOI'].every(flags => dshReaderPrivateAclFromSddl(`${prefix}(A;${flags};FA;;;SY)(A;;FA;;;${owner})`) === undefined)
        && ['GA', 'FR', '0x1f01fe', 'FAFR'].every(rights => dshReaderPrivateAclFromSddl(`${prefix}(A;;${rights};;;SY)(A;;FA;;;${owner})`) === undefined)
        && [valid + 'garbage', valid + '\n' + valid, `${prefix}(A;;FA;;;SY`, `${prefix}(XA;;FA;;;SY)`,
          `${prefix}(A;;FA;object;;SY)`, `O:${owner}G:${owner}D:NO_ACCESS_CONTROL`, valid.replace(';;;SY', ';;;WD')]
          .every(value => dshReaderPrivateAclFromSddl(value) === undefined)
    })()],
  ['same loopback origin is trusted', dshReaderIsTrustedOrigin(sameOrigin)],
  ['only the exact loopback Host is trusted', dshReaderHasTrustedHost(trustedHost) && !dshReaderHasTrustedHost('evil.example:58812')],
  ['startup argument origin accepts an exact DSH origin and rejects an opaque one', dshReaderDesktopOriginFromArguments(
    ['node', 'bridge.mjs', '--dsh-reader-desktop-origin', 'http://127.0.0.1:43129'], undefined,
  ) === 'http://127.0.0.1:43129' && dshReaderDesktopOriginFromArguments(
    ['node', 'bridge.mjs', '--dsh-reader-desktop-origin', 'file:///reader.html'], undefined,
  ) === undefined],
  ['private bridge ACL accepts only current-user SID and SYSTEM explicit FullControl', dshReaderPrivateAclIsTrusted({
    ownerSid: 'S-1-5-21-1-2-3-1001', access: [
      { sid: 'S-1-5-21-1-2-3-1001', accessControlType: 'Allow', fileSystemRights: 'FullControl', isInherited: false },
      { sid: 'S-1-5-18', accessControlType: 'Allow', fileSystemRights: 'FullControl', isInherited: false },
    ],
  }, 'S-1-5-21-1-2-3-1001') && !dshReaderPrivateAclIsTrusted({
    ownerSid: 'S-1-5-21-1-2-3-1001', access: [
      { sid: 'S-1-5-21-1-2-3-1001', accessControlType: 'Allow', fileSystemRights: 'FullControl', isInherited: false },
      { sid: 'S-1-5-32-545', accessControlType: 'Allow', fileSystemRights: 'Modify', isInherited: false },
    ],
  }, 'S-1-5-21-1-2-3-1001')],
  ['private bridge ACL fails closed for noncanonical inherited flags and rights',
    [undefined, null, 'false', 0, true].every((isInherited) => !dshReaderPrivateAclIsTrusted({
      ownerSid: 'S-1-5-21-1-2-3-1001', access: [
        { sid: 'S-1-5-21-1-2-3-1001', accessControlType: 'Allow', fileSystemRights: 'FullControl', isInherited },
        { sid: 'S-1-5-18', accessControlType: 'Allow', fileSystemRights: 'FullControl', isInherited: false },
      ],
    }, 'S-1-5-21-1-2-3-1001'))
    && ['FullControl ', 'FullControl;Modify', 'Read, FullControl'].every((fileSystemRights) => !dshReaderPrivateAclIsTrusted({
      ownerSid: 'S-1-5-21-1-2-3-1001', access: [
        { sid: 'S-1-5-21-1-2-3-1001', accessControlType: 'Allow', fileSystemRights, isInherited: false },
        { sid: 'S-1-5-18', accessControlType: 'Allow', fileSystemRights: 'FullControl', isInherited: false },
      ],
    }, 'S-1-5-21-1-2-3-1001'))],
  ['hostile Host cannot bootstrap without an Origin or token', !dshReaderRequestIsAuthorized({ host: 'evil.example:58812', origin: undefined, hasValidToken: false, bootstrap: true })],
  ['no-Origin bootstrap cannot disclose reader data', !dshReaderRequestIsAuthorized({ host: trustedHost, origin: undefined, hasValidToken: false, bootstrap: true })],
  ['verified iframe bootstrap is accepted', dshReaderRequestIsAuthorized({ host: trustedHost, origin: sameOrigin, hasValidToken: false, bootstrap: true })],
  ['remote origin is rejected without a session token', !dshReaderRequestIsAuthorized({ host: trustedHost, origin: 'https://evil.example', hasValidToken: false, bootstrap: false })],
  ['same-origin iframe requires and accepts a valid session token', dshReaderRequestIsAuthorized({ host: trustedHost, origin: sameOrigin, hasValidToken: true, bootstrap: false })],
  ['native host has no Origin but is accepted with a valid session token', dshReaderRequestIsAuthorized({ host: trustedHost, origin: undefined, hasValidToken: true, bootstrap: false })],
  ['cross-site request is rejected even with a token', !dshReaderRequestIsAuthorized({ host: trustedHost, origin: sameOrigin, fetchSite: 'cross-site', hasValidToken: true, bootstrap: false }) && dshReaderIsCrossSiteFetch('cross-site')],
  ['only indexed PDF assets may be served', dshReaderMatchesIndexedPdfAsset(knownPdf, [knownPdf]) && !dshReaderMatchesIndexedPdfAsset('E:/CLI/llm-wiki/_wiki/private.md', [knownPdf])],
  ['CAS rejects paper C when queue pointer names B', !dshReaderAdvanceMatchesQueue({ paper_id: 'paper:c', slug: 'c', left: 'E:/fake/c.pdf' }, 1, ['a', 'b', 'c'], queueIdentityPapers, thinkingGraph)],
  ['CAS accepts the exact queued paper B', dshReaderAdvanceMatchesQueue({ paper_id: 'paper:b', slug: 'b', left: 'E:/fake/b.pdf' }, 1, ['a', 'b', 'c'], queueIdentityPapers, thinkingGraph)],
  ['known translation-only selection is rejected before an open/state write', dshReaderOpenability(translationOnlyCurrent, translationOnlyPapers, translationOnlyGraph).error === 'missing_original_asset'],
  ['/open guard rejects an explicit unclassified asset before persistence', staleMetadataOpen.ok === false
    && staleMetadataOpen.error === 'missing_original_asset' && staleMetadataOpen.paper?.canonicalCard === '_wiki/references/stale-unclassified.md'],
  ['current response enriches legacy selection without mutating its stored tuple', translationOnlyResponse.error === 'missing_original_asset'
    && translationOnlyResponse.left === undefined && translationOnlyResponse.canonicalCard === '_wiki/references/translation-only.md'
    && translationOnlyResponse.obsidianUrl?.includes('_wiki%2Freferences%2Ftranslation-only.md')
    && translationOnlyResponse.networkViewUrl?.includes('paper%3Atranslation-only')
    && translationOnlyResponse.revision === 'translation-r1' && JSON.stringify(translationOnlyCurrent) === translationOnlyStateSnapshot],
  ['thinking writes a retyped reader item only to its resolved canonical card with exact script arguments', thinkingCommand.ok
    && JSON.stringify(thinkingCommand.args) === JSON.stringify([
      'E:/fixture/append_thinking.py', 'paper:b', '--stdin', '--card', '_wiki/references/b.md',
      '--question', 'What changes?', '--source', 'fixture-reader',
    ])],
  ['thinking rejects a query for another current card without spawning', dshReaderBuildThinkingCommand(
    { ...thinkingRequest, query: 'a' }, thinkingCurrent, queueIdentityPapers, thinkingGraph,
  ).error === 'selection_conflict'],
  ['thinking rejects an older current revision without spawning', dshReaderBuildThinkingCommand(
    { ...thinkingRequest, expectedRevision: 'older-revision' }, thinkingCurrent, queueIdentityPapers, thinkingGraph,
  ).error === 'current_revision_conflict'],
]

for (const [label, passed] of checks) {
  if (!passed) throw new Error(`FAIL ${label}`)
  console.log(`PASS ${label}`)
}

const diagnosticRoot = await mkdtemp(join(tmpdir(), 'dsh-reader-startup-status-'))
try {
  const diagnosticPath = join(diagnosticRoot, 'bridge-startup-status.log')
  const instant = new Date('2026-10-12T22:00:00.000Z')
  const wrote = dshReaderWriteStartupStatus('sid_query', { code: 'ENOENT', message: 'not logged' }, diagnosticPath, instant, 4321)
  const text = await readFile(diagnosticPath, 'ascii')
  const nearCapPath = join(diagnosticRoot, 'near-cap-status.log')
  await writeFile(nearCapPath, 'x'.repeat(32767), 'ascii')
  const nearCapWrote = dshReaderWriteStartupStatus('sid_query', 0, nearCapPath, instant, 4321)
  const nearCapText = await readFile(nearCapPath, 'ascii')
  if (!wrote || text !== '2026-10-12T22:00:00.000Z pid=4321 stage=sid_query code=ENOENT\n'
    || !nearCapWrote
    || Buffer.byteLength(nearCapText, 'ascii') > 32 * 1024
    || nearCapText !== '2026-10-12T22:00:00.000Z pid=4321 stage=sid_query status=0\n'
    || dshReaderStartupStatusLine('unknown_stage', 0, instant, 4321) !== undefined
    || dshReaderStartupStatusLine('sid_query', { code: 'bad-value!' }, instant, 4321)?.includes('bad-value!')) {
    throw new Error('FAIL startup status writer is not bounded ASCII stage/code data')
  }
  console.log('PASS startup diagnostics write only fixed ASCII stage and sanitized code to an isolated target')
} finally {
  await rm(diagnosticRoot, { recursive: true, force: true })
}

const server = createServer((req, res) => { void handleDshReaderRequest(req, res) })
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
try {
  const port = server.address().port
  const request = (path, method, headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
  const trusted = await request('/current', 'OPTIONS', {
    Host: trustedHost, Origin: sameOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-dsh-reader-token',
  })
  if (trusted.status !== 204 || trusted.headers['access-control-allow-origin'] !== sameOrigin
    || trusted.headers['access-control-allow-credentials'] !== 'true'
    || !String(trusted.headers['access-control-allow-headers']).toLowerCase().includes('x-dsh-reader-token')) {
    throw new Error('FAIL trusted endpoint preflight')
  }
  const rejected = await request('/current', 'OPTIONS', {
    Host: trustedHost, Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET',
  })
  if (rejected.status !== 403 || rejected.headers['access-control-allow-origin'] !== undefined) {
    throw new Error('FAIL remote endpoint preflight rejection')
  }
  const trustedBootstrap = await request('/bootstrap', 'POST', { Host: trustedHost, Origin: sameOrigin })
  if (trustedBootstrap.status !== 204 || !String(trustedBootstrap.headers['set-cookie']).includes('HttpOnly')) {
    throw new Error('FAIL exact-origin browser bootstrap')
  }
  const remoteBootstrap = await request('/bootstrap', 'POST', { Host: trustedHost, Origin: 'https://evil.example' })
  if (remoteBootstrap.status !== 403 || remoteBootstrap.headers['set-cookie'] !== undefined) {
    throw new Error('FAIL remote browser bootstrap rejection')
  }
  const hostileHost = await request('/', 'GET', { Host: 'evil.example:58812' })
  if (hostileHost.status !== 403 || hostileHost.headers['set-cookie'] !== undefined) throw new Error('FAIL hostile Host bootstrap rejection')
  const noOrigin = await request('/', 'GET', { Host: trustedHost })
  if (noOrigin.status !== 403 || noOrigin.headers['set-cookie'] !== undefined) throw new Error('FAIL no-Origin bootstrap rejection')
  console.log('PASS endpoint preflight and bootstrap enforce exact Host and trusted iframe origin')

} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

// Run the real Windows SID + ACL executables against an isolated temporary
// directory after removing PATH from the child environment. This proves the
// bridge's absolute SystemRoot tool paths work without touching a bridge
// token, reader state, queue, vault, or service.
if (process.platform === 'win32') {
  const aclFixture = await mkdtemp(join(tmpdir(), 'dsh-reader-acl-tools-'))
  try {
    const tools = dshReaderWindowsSystemTools(process.env.SystemRoot)
    const sid = dshReaderCurrentUserSid(tools, withoutPath(process.env))
    if (typeof sid !== 'string' || sid.length === 0) throw new Error('FAIL absolute whoami did not return a SID with PATH removed')
    const restrictedEnv = systemOnlyPath(process.env)
    dshReaderSetPrivateAcl(aclFixture, sid, true, tools, restrictedEnv)
    const acl = dshReaderReadPrivateAcl(aclFixture, tools, restrictedEnv)
    if (!dshReaderAssertPrivateAcl(aclFixture, sid, tools, restrictedEnv)) {
      const shape = {
        hasAcl: acl !== undefined,
        accessArray: Array.isArray(acl?.access),
        accessCount: Array.isArray(acl?.access) ? acl.access.length : -1,
        ownerMatches: typeof acl?.ownerSid === 'string' && acl.ownerSid.toUpperCase() === sid.toUpperCase(),
        trusted: dshReaderPrivateAclIsTrusted(acl, sid),
      }
      throw new Error(`FAIL absolute PowerShell/icacls did not produce a trusted ACL with a System32-only PATH: ${JSON.stringify(shape)}`)
    }
    if (!dshReaderAssertPrivateAcl(aclFixture, sid, tools, { ...restrictedEnv,
      PSMODULEPATH: 'E:/untrusted/module-root', PSModulePath: 'E:/untrusted/other-module-root' })) {
      throw new Error('FAIL ACL cmdlet inherited an untrusted module search root')
    }
    const { execFileSync } = await import('node:child_process')
    const constrained = execFileSync(tools.powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; (Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:DSH_READER_ACL_PATH).Sddl"], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...Object.fromEntries(Object.entries(restrictedEnv).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
        PSModulePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/Modules', DSH_READER_ACL_PATH: aclFixture },
    })
    if (!dshReaderPrivateAclIsTrusted(dshReaderPrivateAclFromSddl(constrained), sid)) throw new Error('FAIL built-in ACL query under isolated ConstrainedLanguage')
    console.log('PASS pinned whoami/icacls and built-in ACL query enforce private SID ACL, including isolated ConstrainedLanguage')
  } finally {
    await rm(aclFixture, { recursive: true, force: true })
  }
} else {
  console.log('SKIP absolute Windows ACL tool execution (non-Windows host)')
}

// Isolated bridge asset-guard fixture.  The files are real, and all three are
// listed in the legacy index.  The prepared graph availability map must deny
// both graph-recorded `available:false` files before legacy fast-path access,
// while a graph-unrecognized legacy PDF remains usable.
const assetRoot = await mkdtemp(join(tmpdir(), 'dsh-reader-asset-guard-'))
const assetDirectory = join(assetRoot, 'pdfs')
await mkdir(assetDirectory, { recursive: true })
const unavailableOriginal = join(assetDirectory, 'unavailable-original.pdf')
const unavailableTranslation = join(assetDirectory, 'unavailable-translation.pdf')
const availableOriginal = join(assetDirectory, 'available-original.pdf')
const legacyOnly = join(assetDirectory, 'legacy-only.pdf')
await Promise.all([unavailableOriginal, unavailableTranslation, availableOriginal, legacyOnly].map((path) => writeFile(path, '%PDF-fixture', 'utf8')))
const assetGuardPapers = [
  { paper_id: 'paper:guard-original', slug: 'guard-original', title: 'Guard original', pdfEn: unavailableOriginal },
  { paper_id: 'paper:guard-translation', slug: 'guard-translation', title: 'Guard translation', pdfEn: availableOriginal, pdfZh: unavailableTranslation },
  { paper_id: 'paper:legacy-only', slug: 'legacy-only', title: 'Legacy only', pdfEn: legacyOnly },
]
const assetGuardGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [
    { id: 'paper:guard-original', type: 'paper', label: 'Guard original', card: '_wiki/references/guard-original.md', metadata: {
      paper_id: 'paper:guard-original', reader_slugs: ['guard-original'], pdf_en: ['pdfs/unavailable-original.pdf'],
      assets: [{ path: 'pdfs/unavailable-original.pdf', raw_path: unavailableOriginal, role: 'original', available: false }],
    } },
    { id: 'paper:guard-translation', type: 'paper', label: 'Guard translation', card: '_wiki/references/guard-translation.md', metadata: {
      paper_id: 'paper:guard-translation', reader_slugs: ['guard-translation'], pdf_en: [availableOriginal], pdf_zh: ['pdfs/unavailable-translation.pdf'],
      assets: [
        { path: availableOriginal, raw_path: availableOriginal, role: 'original' },
        { path: 'pdfs/unavailable-translation.pdf', raw_path: unavailableTranslation, role: 'translation', available: false },
      ],
    } },
  ],
}, { vaultRoot: assetRoot })
const assetGuardOptions = { libraryRoot: assetRoot, papers: assetGuardPapers, graph: assetGuardGraph }
let fixtureReadWrites = 0
const fixtureServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const filePath = url.searchParams.get('path') ?? ''
  const accepted = dshReaderResolveIndexedPdfPathFor(filePath, undefined, assetGuardOptions)
  if (url.pathname !== '/file' && url.pathname !== '/read') { res.writeHead(404); res.end(); return }
  if (accepted === null) { res.writeHead(403); res.end(); return }
  if (url.pathname === '/read') fixtureReadWrites += 1
  res.writeHead(200); res.end()
})
await new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', resolve) })
try {
  const port = fixtureServer.address().port
  const requestAsset = (endpoint, filePath) => new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: `${endpoint}?path=${encodeURIComponent(filePath)}`, method: endpoint === '/read' ? 'POST' : 'GET' }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject); request.end()
  })
  const unavailableRequests = [
    unavailableOriginal,
    unavailableTranslation,
    `${assetDirectory}\\..\\pdfs\\unavailable-original.pdf`,
    `${assetDirectory}\\..\\pdfs\\unavailable-translation.pdf`,
  ]
  for (const unavailable of unavailableRequests) {
    if (await requestAsset('/file', unavailable) !== 403 || await requestAsset('/read', unavailable) !== 403) {
      throw new Error('FAIL unavailable graph asset was served through the legacy index or an equivalent path')
    }
  }
  if (fixtureReadWrites !== 0) throw new Error('FAIL unavailable graph asset mutated fixture read state')
  if (await requestAsset('/file', legacyOnly) !== 200 || await requestAsset('/read', legacyOnly) !== 200 || fixtureReadWrites !== 1) {
    throw new Error('FAIL graph-unrecognized legacy indexed PDF was not preserved')
  }
  console.log('PASS bridge HTTP asset availability guard rejects unavailable graph assets before legacy access')
} finally {
  await new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()))
  await rm(assetRoot, { recursive: true, force: true })
}
