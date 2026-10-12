import { execFileSync } from 'node:child_process'

const opener = 'C:\\Windows\\System32\\rundll32.exe'
const handler = 'C:\\Windows\\System32\\url.dll,FileProtocolHandler'
const vault = 'llm-wiki'

function cardUri(card) {
  if (typeof card !== 'string' || card.length > 2048 || !card.endsWith('.md')
    || /[\\:\u0000-\u001f\u007f]/u.test(card)
    || card.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(card)}`
}

/** Only the resolved current graph item and its concept/task/method cards can open. */
export function readerObsidianUriFor(request, paper) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.href !== 'string' || request.href.length > 8192
    || !paper || paper.legacy === true || typeof paper.paperId !== 'string'
    || paper.paperId.length === 0 || cardUri(paper.canonicalCard) === undefined) return undefined
  const allowed = new Set([
    `obsidian://paper-network?vault=${encodeURIComponent(vault)}&node=${encodeURIComponent(paper.paperId)}`,
    cardUri(paper.canonicalCard),
  ])
  for (const key of ['concepts', 'tasks', 'methods']) {
    const rows = paper.context?.[key]
    for (const row of Array.isArray(rows) ? rows : []) {
      const uri = cardUri(row?.card)
      if (uri !== undefined) allowed.add(uri)
    }
  }
  return allowed.has(request.href) ? request.href : undefined
}

/** argv is fixed; request URLs never reach a shell or an arbitrary application. */
export function readerOpenObsidian(request, paper, options = {}) {
  const uri = readerObsidianUriFor(request, paper)
  if (uri === undefined) return { ok: false, error: 'navigation_not_current' }
  const root = options.systemRoot ?? process.env.SystemRoot
  if (root !== undefined && (typeof root !== 'string'
    || root.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase() !== 'c:\\windows')) {
    return { ok: false, error: 'trusted_opener_unavailable' }
  }
  try {
    const run = options.run ?? execFileSync
    run(opener, [handler, uri], {
      windowsHide: true, stdio: 'ignore', shell: false, timeout: 10000,
    })
    return { ok: true }
  } catch {
    return { ok: false, error: 'obsidian_launch_failed' }
  }
}
