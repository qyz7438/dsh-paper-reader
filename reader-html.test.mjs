/**
 * Isolated reader.html regression checks. The production page is an inline
 * browser script, so extract its small DOM-free helpers and execute them in a
 * fresh VM rather than starting a bridge or mutating reader state.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const sourcePath = new URL('./reader.html', import.meta.url)
const source = await readFile(sourcePath, 'utf8')

function extractFunction(name) {
  const marker = `function ${name}(`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing ${name}`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `missing ${name} body`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unterminated ${name}`)
}

const helperNames = [
  'dshReaderFollowModeForSearch',
  'dshReaderThinkingExpectedRevision',
  'dshReaderThinkingPayloadFor',
  'dshReaderFollowCurrentPayload',
  'dshReaderNavigateObsidianHref',
]
const context = { URLSearchParams }
vm.createContext(context)
vm.runInContext(
  `${helperNames.map(extractFunction).join('\n')}\nthis.helpers = { ${helperNames.join(', ')} }`,
  context,
  { filename: sourcePath.pathname },
)
const helpers = context.helpers

assert.equal(helpers.dshReaderFollowModeForSearch('?theme=dark'), true)
assert.equal(helpers.dshReaderFollowModeForSearch('?left=E%3A%2Fpaper.pdf&theme=dark'), false)
assert.equal(helpers.dshReaderFollowModeForSearch('?right=E%3A%2Ftranslation.pdf&theme=dark'), false)

const networkCurrent = {
  paper_id: 'paper:network',
  slug: 'network-paper',
  left: 'E:/library/network.pdf',
  canonicalCard: '_wiki/references/network.md',
  network: { concepts: [{ id: 'concept:graph', label: 'Graph' }] },
  updatedAt: '2026-10-12T22:03:04.000Z',
}
const followed = helpers.dshReaderFollowCurrentPayload(networkCurrent)
assert.ok(followed)
assert.equal(followed.identity, networkCurrent)
assert.equal(followed.network, networkCurrent.network)

const legacyThinking = helpers.dshReaderThinkingPayloadFor(networkCurrent)
assert.equal(JSON.stringify(legacyThinking), JSON.stringify({
  paper_id: 'paper:network',
  slug: 'network-paper',
  left: 'E:/library/network.pdf',
  query: 'network-paper',
  expectedRevision: '2026-10-12T22:03:04.000Z',
}))
assert.equal(
  helpers.dshReaderThinkingPayloadFor({ ...networkCurrent, revision: 'r-new' }).expectedRevision,
  'r-new',
)
assert.equal(helpers.dshReaderThinkingPayloadFor({ ...networkCurrent, updatedAt: '' }), null)

assert.match(source, /const followed = dshReaderFollowCurrentPayload\(cur\);/)
assert.match(source, /currentThinkingIdentity = current;/)
assert.match(source, /renderNetworkContext\(current\);/)

let navigationCalls = []
context.bridgeFetch = (path, options) => {
  navigationCalls.push({ path, options })
  return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
}
const nativeUri = 'obsidian://paper-network?vault=llm-wiki&node=paper%3Anetwork'
assert.equal(await helpers.dshReaderNavigateObsidianHref(nativeUri), true)
assert.equal(navigationCalls.length, 1)
assert.equal(navigationCalls[0].path, '/obsidian')
assert.equal(navigationCalls[0].options.method, 'POST')
assert.equal(JSON.parse(navigationCalls[0].options.body).href, nativeUri)
await assert.rejects(helpers.dshReaderNavigateObsidianHref('https://attacker.invalid'), /invalid_navigation/)
assert.equal(navigationCalls.length, 1)
context.bridgeFetch = () => Promise.resolve({ ok: false, json: async () => ({ ok: false }) })
await assert.rejects(helpers.dshReaderNavigateObsidianHref(nativeUri), /navigation_failed/)

console.log('PASS reader.html follow-mode, network identity, legacy CAS fallback, and authenticated navigation')
