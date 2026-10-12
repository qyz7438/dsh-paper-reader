import assert from 'node:assert/strict'
import { readerObsidianUriFor, readerOpenObsidian } from './reader-obsidian-navigation.mjs'

const paper = {
  paperId: 'paper:doi:10.1109/example', canonicalCard: '_wiki/references/example.md',
  context: { concepts: [{ card: '_wiki/network/concepts/graph.md' }] },
}
const graph = 'obsidian://paper-network?vault=llm-wiki&node=paper%3Adoi%3A10.1109%2Fexample'
const card = 'obsidian://open?vault=llm-wiki&file=_wiki%2Freferences%2Fexample.md'
const concept = 'obsidian://open?vault=llm-wiki&file=_wiki%2Fnetwork%2Fconcepts%2Fgraph.md'
const snapshot = JSON.stringify(paper)
let calls = []
const run = (...args) => calls.push(args)
for (const href of [graph, card, concept]) {
  assert.equal(readerObsidianUriFor({ href }, paper), href)
  assert.deepEqual(readerOpenObsidian({ href }, paper, { systemRoot: 'C:/Windows', run }), { ok: true })
}
assert.equal(calls.length, 3)
for (const [command, args, options] of calls) {
  assert.equal(command, 'C:\\Windows\\System32\\rundll32.exe')
  assert.equal(args[0], 'C:\\Windows\\System32\\url.dll,FileProtocolHandler')
  assert.ok([graph, card, concept].includes(args[1]))
  assert.equal(args.length, 2)
  assert.equal(options.shell, false)
  assert.equal(options.windowsHide, true)
  assert.equal(options.stdio, 'ignore')
}
calls = []
for (const href of [undefined, 'https://attacker.invalid', 'file:///C:/secret',
  'obsidian://open?vault=another&file=_wiki%2Freferences%2Fexample.md',
  graph + '&command=delete', graph.replace('example', 'other'),
  'obsidian://open?vault=llm-wiki&file=..%2Fsecret.md', 'x'.repeat(8193)]) {
  assert.deepEqual(readerOpenObsidian({ href }, paper, { run }), { ok: false, error: 'navigation_not_current' })
}
for (const candidate of [undefined, { ...paper, legacy: true }, { ...paper, canonicalCard: '../secret.md' },
  { ...paper, canonicalCard: 'C:/secret.md' }, { ...paper, canonicalCard: '_wiki/secret\u0000.md' }]) {
  assert.equal(readerObsidianUriFor({ href: graph }, candidate), undefined)
}
assert.equal(readerObsidianUriFor({ href: concept }, { ...paper, context: {} }), undefined)
assert.equal(readerObsidianUriFor({ href: card }, { ...paper, canonicalCard: '_wiki/references/other.md' }), undefined)
assert.equal(readerOpenObsidian({ href: graph }, paper, { systemRoot: 'E:/fake', run }).error, 'trusted_opener_unavailable')
assert.equal(calls.length, 0)
assert.equal(readerOpenObsidian({ href: graph }, paper, { run() { throw new Error('secret stderr') } }).error, 'obsidian_launch_failed')
assert.equal(JSON.stringify(paper), snapshot)
console.log('PASS 5 navigation cases: current graph/card/context, fixed argv, hostile/stale targets, trusted root, silent-data-safe failure')
