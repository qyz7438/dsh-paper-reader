import assert from 'node:assert/strict'
import {
  buildCurrentPayload,
  createPaperGraphAdapter,
  isLiveRead,
  prepareNormalizedReaderPaperResolver,
  prepareReaderPaperResolver,
  resolveCurrentPaper,
  resolveQueuePaper,
} from './paper-graph-adapter.js'

const entries = [
  { paper_id: 'paper:alpha', slug: 'alpha-old', title: 'Alpha', pdfEn: 'E:/fake/alpha.en.pdf', read: false },
  { paper_id: 'paper:beta', slug: 'beta-old', title: 'Beta', pdfEn: 'E:/fake/beta.en.pdf', pdfZh: 'E:/fake/beta.zh.pdf', read: false },
  { paper_id: 'paper:gamma', slug: 'gamma-old', title: 'Gamma', pdfEn: 'E:/fake/gamma.en.pdf', read: false },
]

const graph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1',
  nodes: [
    { id: 'concept:representation', type: 'concept', label: 'Representation', card: '_wiki/concepts/representation.md' },
    { id: 'task:retrieval', type: 'task', label: 'Retrieval', card: '_wiki/tasks/retrieval.md' },
    {
      id: 'paper:alpha', type: 'paper', label: 'Alpha', card: '_wiki/references/alpha.md',
      metadata: { paper_id: 'paper:alpha', reader_slugs: ['alpha-old'], pdf_en: 'E:/fake/alpha.en.pdf', concept_ids: ['concept:representation'], task_ids: ['task:retrieval'], method_ids: [] },
    },
    {
      id: 'paper:beta', type: 'paper', label: 'Beta', card: '_wiki/references/beta.md',
      metadata: { paper_id: 'paper:beta', reader_slugs: ['beta-old'], pdf_en: 'E:/fake/beta.en.pdf', pdf_zh: 'E:/fake/beta.zh.pdf', concept_ids: ['concept:representation'], task_ids: ['task:retrieval'], method_ids: [] },
    },
    {
      id: 'paper:gamma', type: 'paper', label: 'Gamma', card: '_wiki/references/gamma.md',
      metadata: { paper_id: 'paper:gamma', reader_slugs: ['gamma-old'], pdf_en: 'E:/fake/gamma.en.pdf', concept_ids: [], task_ids: [], method_ids: [] },
    },
  ],
})

// A pre-migration current record has only a path.  It resolves to Beta even
// though the retained legacy queue's pointer still identifies Alpha.
const current = resolveCurrentPaper({ left: 'E:/fake/beta.en.pdf' }, entries, graph)
assert.equal(current?.paperId, 'paper:beta')
assert.equal(current?.slug, 'beta-old')
assert.equal(current?.canonicalCard, '_wiki/references/beta.md')
assert.equal(current?.context?.concepts[0]?.label, 'Representation')
assert.equal(current?.context?.tasks[0]?.label, 'Retrieval')
assert.equal(resolveQueuePaper('alpha-old', entries, graph)?.paperId, 'paper:alpha')

// A response prepares one immutable, collision-aware snapshot.  The batch
// API is explicit so callers do not retain a stale resolver across responses.
const prepared = prepareReaderPaperResolver(entries, graph)
assert.deepEqual(prepared.preparation, { entryCount: entries.length, normalizedEntryCount: entries.length, indexBuilds: 1 })
assert.deepEqual(prepared.resolveCurrent({ left: 'E:/fake/beta.en.pdf' }), current)
assert.equal(prepared.resolveQueue('alpha-old')?.paperId, 'paper:alpha')
const hostPrepared = prepareNormalizedReaderPaperResolver(prepared.entries, graph)
assert.deepEqual(hostPrepared.preparation, { entryCount: entries.length, normalizedEntryCount: 0, indexBuilds: 1 })
assert.deepEqual(hostPrepared.resolveCurrent({ left: 'E:/fake/beta.en.pdf' }), current)

const collidingPrepared = prepareReaderPaperResolver([
  { paper_id: 'paper:one', slug: 'shared', title: 'One', pdfEn: 'E:/fake/one.pdf' },
  { paper_id: 'paper:two', slug: 'shared', title: 'Two', pdfEn: 'E:/fake/two.pdf' },
])
assert.equal(collidingPrepared.resolveCurrent({ slug: 'shared' }), undefined)

const payload = buildCurrentPayload(current, { vaultName: 'llm-wiki', networkViewUrl: 'obsidian://paper-network' })
assert.equal(payload?.paper_id, 'paper:beta')
assert.equal(payload?.canonicalCard, '_wiki/references/beta.md')
assert.equal(payload?.right, 'E:/fake/beta.zh.pdf')
assert.equal(payload?.obsidianUrl, 'obsidian://open?vault=llm-wiki&file=_wiki%2Freferences%2Fbeta.md')
assert.equal(payload?.networkViewUrl, 'obsidian://paper-network')

// Live reader state overrides the old snapshot.  A card's read_status/AI
// material never participates, so an unknown path stays unread.
assert.equal(isLiveRead({ ...current, read: false }, { 'E:/fake/beta.en.pdf': true }), true)
assert.equal(isLiveRead({ ...current, read: false }, {}), false)
assert.equal(resolveCurrentPaper({ left: 'E:/fake/missing.pdf' }, entries, graph), undefined)
assert.equal(
  resolveCurrentPaper({ paper_id: 'paper:alpha', slug: 'beta-old', left: 'E:/fake/beta.en.pdf' }, entries, graph),
  undefined,
)
const arrayGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:assets', type: 'paper', label: 'Assets',
    metadata: { paper_id: 'paper:assets', reader_slugs: ['assets'],
      pdf_en: ['E:/fake/assets-v1.pdf', 'E:/fake/assets-v2.pdf'],
      pdf_zh: ['E:/fake/assets.zh.pdf'] },
  }],
})
assert.equal(resolveCurrentPaper({ left: 'e:\\fake\\assets-v2.pdf' }, [], arrayGraph)?.pdfEn, 'E:/fake/assets-v2.pdf')
assert.equal(resolveCurrentPaper({ paper_id: 'paper:assets', left: 'E:/fake/assets-v2.pdf' }, [], arrayGraph)?.paperId, 'paper:assets')
assert.equal(resolveCurrentPaper({ paper_id: 'paper:assets', slug: 'assets', left: 'E:/fake/assets-v2.pdf' }, [], arrayGraph)?.pdfEn, 'E:/fake/assets-v2.pdf')
assert.equal(resolveCurrentPaper({ paper_id: 'paper:assets', left: 'E:/fake/assets-v1.pdf', slug: 'other' }, [], arrayGraph), undefined)
const preparedAssets = prepareReaderPaperResolver([], arrayGraph)
assert.equal(preparedAssets.resolveCurrent({ paper_id: 'paper:assets', slug: 'assets', left: 'E:/fake/assets-v2.pdf' })?.pdfEn, 'E:/fake/assets-v2.pdf')

const relativeAssetGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:relative', type: 'paper', label: 'Relative', card: '_wiki/references/relative.md',
    metadata: { paper_id: 'paper:relative', reader_slugs: ['relative'], pdf_en: ['pdfs/relative.pdf'],
      assets: [{ path: 'pdfs/relative.pdf', raw_path: 'pdfs\\relative.pdf', role: 'original' }] },
  }],
}, { vaultRoot: 'E:/vault' })
assert.equal(resolveCurrentPaper({ slug: 'relative', left: 'pdfs/relative.pdf' }, [], relativeAssetGraph)?.pdfEn, 'E:/vault\\pdfs\\relative.pdf')

// The graph's recorded raw paths bridge legacy absolute selections to the
// canonical graph identity.  A translation alias remains an overlay path and
// never becomes the English asset opened by the reader.
const legacyMirror = 'E:/vault/mirror.pdf'
const rawAssetGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:raw-assets', type: 'paper', label: 'Raw assets', card: '_wiki/references/raw-assets.md',
    metadata: {
      paper_id: 'paper:raw-assets', reader_slugs: ['raw-assets', 'raw-assets-mirror'],
      pdf_en: ['pdfs/original-v1.pdf', 'pdfs/original-v2.pdf'], pdf_zh: ['pdfs/mirror.pdf'],
      assets: [
        { path: 'pdfs/original-v1.pdf', raw_path: 'E:/vault/original-v1.pdf', recorded_role: 'original' },
        { path: 'pdfs/original-v2.pdf', raw_path: 'E:/vault/original-v2.pdf', role: 'original' },
        { path: 'pdfs/mirror.pdf', raw_path: legacyMirror, recorded_role: 'translation' },
      ],
    },
  }],
})
const mirrorSelection = resolveCurrentPaper({
  paper_id: 'paper:raw-assets', slug: 'raw-assets-mirror', left: legacyMirror,
}, [], rawAssetGraph)
assert.equal(mirrorSelection?.pdfEn, 'E:/vault/original-v1.pdf')
assert.equal(mirrorSelection?.pdfZh, legacyMirror)
assert.equal(mirrorSelection?.progressPaths[0], legacyMirror)
assert.equal(isLiveRead(mirrorSelection, { [legacyMirror]: true }), true)
assert.equal(buildCurrentPayload(mirrorSelection)?.left, 'E:/vault/original-v1.pdf')
assert.equal(buildCurrentPayload(mirrorSelection)?.right, legacyMirror)
assert.equal(resolveCurrentPaper({ left: 'E:/vault/original-v2.pdf' }, [], rawAssetGraph)?.pdfEn, 'E:/vault/original-v2.pdf')

// `role` corrects historical provenance.  The translation is deliberately
// first so prioritizing `recorded_role` would incorrectly open it as English.
const correctedRoleMirror = 'E:/vault/corrected-mirror.pdf'
const correctedRoleGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:corrected-role', type: 'paper', label: 'Corrected role', card: '_wiki/references/corrected-role.md',
    metadata: {
      paper_id: 'paper:corrected-role', reader_slugs: ['corrected-role'],
      pdf_en: ['pdfs/corrected-original.pdf'], pdf_zh: ['pdfs/corrected-mirror.pdf'],
      assets: [
        { path: 'pdfs/corrected-mirror.pdf', raw_path: correctedRoleMirror, recorded_role: 'original', role: 'translation' },
        { path: 'pdfs/corrected-original.pdf', raw_path: 'E:/vault/corrected-original.pdf', recorded_role: 'original', role: 'original' },
      ],
    },
  }],
})
const correctedRoleSelection = resolveCurrentPaper({ left: correctedRoleMirror }, [], correctedRoleGraph)
assert.equal(correctedRoleSelection?.pdfEn, 'E:/vault/corrected-original.pdf')
assert.equal(correctedRoleSelection?.pdfZh, correctedRoleMirror)

const invalidRolePath = 'E:/vault/invalid-role.pdf'
const invalidRoleGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:invalid-role', type: 'paper', label: 'Invalid role', card: '_wiki/references/invalid-role.md',
    metadata: {
      paper_id: 'paper:invalid-role', reader_slugs: ['invalid-role'], pdf_en: ['pdfs/invalid-role.pdf'],
      assets: [{ path: 'pdfs/invalid-role.pdf', raw_path: invalidRolePath, recorded_role: 'original', role: 'unclassified' }],
    },
  }],
})
assert.equal(invalidRoleGraph.paperByPdf(invalidRolePath), undefined)
assert.equal(resolveCurrentPaper({ left: invalidRolePath }, [], invalidRoleGraph), undefined)

// A corrected asset role also governs stale metadata.pdf_en.  Every alias of
// that same asset (vault-relative path, raw_path, and vault-resolved path)
// must be excluded from canonical English paths; only truly role-absent
// historical records retain metadata compatibility.
const staleMetadataAsset = 'E:/vault/stale-metadata.pdf'
const staleMetadataGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [
    {
      id: 'paper:stale-unclassified', type: 'paper', label: 'Stale unclassified', card: '_wiki/references/stale-unclassified.md',
      metadata: {
        paper_id: 'paper:stale-unclassified', reader_slugs: ['stale-unclassified'], pdf_en: ['pdfs/stale-metadata.pdf'],
        assets: [{ path: 'pdfs/stale-metadata.pdf', raw_path: staleMetadataAsset, recorded_role: 'original', role: 'unclassified' }],
      },
    },
    {
      id: 'paper:stale-translation', type: 'paper', label: 'Stale translation', card: '_wiki/references/stale-translation.md',
      metadata: {
        paper_id: 'paper:stale-translation', reader_slugs: ['stale-translation'], pdf_en: ['pdfs/stale-translation.pdf'],
        assets: [{ path: 'pdfs/stale-translation.pdf', raw_path: 'E:/vault/stale-translation.pdf', recorded_role: 'original', role: 'translation' }],
      },
    },
    {
      id: 'paper:role-absent', type: 'paper', label: 'Role absent', card: '_wiki/references/role-absent.md',
      metadata: {
        paper_id: 'paper:role-absent', reader_slugs: ['role-absent'], pdf_en: ['pdfs/role-absent.pdf'],
        assets: [{ path: 'pdfs/role-absent.pdf', raw_path: 'E:/vault/role-absent.pdf', recorded_role: 'original' }],
      },
    },
  ],
}, { vaultRoot: 'E:/vault' })
const staleUnclassified = staleMetadataGraph.paperById('paper:stale-unclassified')
assert.equal(staleUnclassified?.pdfEn, undefined)
assert.equal(staleUnclassified?.pdfZh, undefined)
for (const alias of ['pdfs/stale-metadata.pdf', staleMetadataAsset, 'E:/vault\\pdfs\\stale-metadata.pdf']) {
  assert.equal(staleMetadataGraph.paperByPdf(alias), undefined)
}
assert.equal(buildCurrentPayload(resolveCurrentPaper({ paper_id: 'paper:stale-unclassified', slug: 'stale-unclassified' }, [], staleMetadataGraph)), undefined)
assert.equal(staleMetadataGraph.paperById('paper:stale-translation')?.pdfEn, undefined)
assert.equal(staleMetadataGraph.paperById('paper:stale-translation')?.pdfZh, 'E:/vault/stale-translation.pdf')
assert.equal(staleMetadataGraph.paperById('paper:role-absent')?.pdfEn, 'E:/vault/role-absent.pdf')

// A graph's explicit availability receipt is just as authoritative as its
// role: an unavailable translation must not block an otherwise valid English
// open, and an unavailable original must not be fabricated from pdf_en. The
// asset aliases remain identity/progress keys, not readable payload paths.
const unavailableTranslationPath = 'E:/vault/missing-translation.pdf'
const unavailableOriginalPath = 'E:/vault/missing-original.pdf'
const availabilityGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [
    {
      id: 'paper:available-original', type: 'paper', label: 'Available original', card: '_wiki/references/available-original.md',
      metadata: {
        paper_id: 'paper:available-original', reader_slugs: ['available-original'],
        pdf_en: ['pdfs/available-original.pdf'], pdf_zh: ['pdfs/missing-translation.pdf'],
        assets: [
          { path: 'pdfs/available-original.pdf', raw_path: 'E:/vault/available-original.pdf', role: 'original' },
          { path: 'pdfs/missing-translation.pdf', raw_path: unavailableTranslationPath, role: 'translation', available: false },
        ],
      },
    },
    {
      id: 'paper:missing-original', type: 'paper', label: 'Missing original', card: '_wiki/references/missing-original.md',
      metadata: {
        paper_id: 'paper:missing-original', reader_slugs: ['missing-original'], pdf_en: ['pdfs/missing-original.pdf'],
        assets: [{ path: 'pdfs/missing-original.pdf', raw_path: unavailableOriginalPath, role: 'original', available: false }],
      },
    },
  ],
}, { vaultRoot: 'E:/vault' })
const availableOriginal = resolveCurrentPaper({ left: 'E:/vault/available-original.pdf' }, [], availabilityGraph)
assert.equal(availabilityGraph.assetAvailabilityFor(unavailableTranslationPath), false)
assert.equal(availabilityGraph.assetAvailabilityFor('pdfs/missing-translation.pdf'), false)
assert.equal(availabilityGraph.assetAvailabilityFor('E:/vault\\pdfs\\missing-translation.pdf'), false)
assert.equal(availabilityGraph.assetAvailabilityFor('E:/vault/available-original.pdf'), undefined)
assert.equal(availableOriginal?.pdfEn, 'E:/vault/available-original.pdf')
assert.equal(availableOriginal?.pdfZh, undefined)
const availableOriginalPayload = buildCurrentPayload(availableOriginal)
assert.equal(availableOriginalPayload?.left, 'E:/vault/available-original.pdf')
assert.equal(availableOriginalPayload?.right, undefined)
const unavailableTranslationIdentity = resolveCurrentPaper({ left: unavailableTranslationPath }, [], availabilityGraph)
assert.equal(unavailableTranslationIdentity?.paperId, 'paper:available-original')
assert.equal(unavailableTranslationIdentity?.pdfZh, undefined)
assert.equal(unavailableTranslationIdentity?.progressPaths[0], unavailableTranslationPath)
const missingOriginal = resolveCurrentPaper({ left: unavailableOriginalPath }, [], availabilityGraph)
assert.equal(missingOriginal?.canonicalCard, '_wiki/references/missing-original.md')
assert.equal(missingOriginal?.pdfEn, undefined)
assert.equal(buildCurrentPayload(missingOriginal), undefined)

// A translation-only retained item still resolves to its card and preserves
// the legacy progress key, but cannot become an English reader payload.
const translationOnlyPath = 'E:/vault/translation-only_镜像.pdf'
const translationOnlyGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [{
    id: 'paper:translation-only', type: 'paper', label: 'Translation only', card: '_wiki/references/translation-only.md',
    metadata: {
      paper_id: 'paper:translation-only', reader_slugs: ['translation-only'], pdf_en: [], pdf_zh: ['pdfs/translation-only_镜像.pdf'],
      assets: [{ path: 'pdfs/translation-only_镜像.pdf', raw_path: translationOnlyPath, role: 'translation' }],
    },
  }],
})
const translationOnly = resolveCurrentPaper({ left: translationOnlyPath }, [], translationOnlyGraph)
assert.equal(translationOnly?.canonicalCard, '_wiki/references/translation-only.md')
assert.equal(translationOnly?.pdfEn, undefined)
assert.equal(translationOnly?.pdfZh, translationOnlyPath)
assert.equal(isLiveRead(translationOnly, { [translationOnlyPath]: true }), true)
assert.equal(buildCurrentPayload(translationOnly), undefined)

const collidedRawAssetGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: ['one', 'two'].map((suffix) => ({
    id: `paper:${suffix}`, type: 'paper', label: suffix, card: `_wiki/references/${suffix}.md`,
    metadata: {
      paper_id: `paper:${suffix}`, reader_slugs: [suffix], pdf_en: [`pdfs/${suffix}.pdf`],
      assets: [{ path: `pdfs/${suffix}.pdf`, raw_path: 'E:/vault/shared.pdf', recorded_role: 'original' }],
    },
  })),
})
assert.equal(collidedRawAssetGraph.paperByPdf('E:/vault/shared.pdf'), undefined)
assert.equal(resolveCurrentPaper({ left: 'E:/vault/shared.pdf' }, [], collidedRawAssetGraph), undefined)

const retypedReaderGraph = createPaperGraphAdapter({
  schema_version: 'paper-network-v1', nodes: [
    {
      id: 'paper:local:6031c6453c5d413460d6', type: 'topic', label: 'AI Infrastructure Training',
      card: '_wiki/references/papers/论文-aiinfra_training.md',
      metadata: { paper_id: 'paper:local:6031c6453c5d413460d6', reader_slugs: ['aiinfra_training'], pdf_en: 'E:/fake/aiinfra_training.pdf' },
    },
    // A normal navigation topic remains absent because it has no retained
    // reader identity and asset, even though its type matches the item above.
    { id: 'topic:navigation', type: 'topic', label: 'Navigation', card: '_wiki/topics/navigation.md', metadata: {} },
  ],
})
const retyped = resolveCurrentPaper({
  paper_id: 'paper:local:6031c6453c5d413460d6', slug: 'aiinfra_training', left: 'E:/fake/aiinfra_training.pdf',
}, [], retypedReaderGraph)
assert.equal(retyped?.canonicalCard, '_wiki/references/papers/论文-aiinfra_training.md')
assert.equal(retyped?.nodeType, 'topic')
assert.equal(retyped?.context?.nodeType, 'topic')
assert.equal(buildCurrentPayload(retyped, { vaultName: 'llm-wiki' })?.canonicalCard, '_wiki/references/papers/论文-aiinfra_training.md')
assert.equal(retypedReaderGraph.paperBySlug('navigation'), undefined)
assert.equal(resolveCurrentPaper({ slug: 'aiinfra_training', left: 'E:/fake/other.pdf' }, [], retypedReaderGraph), undefined)
assert.equal(prepareReaderPaperResolver([], retypedReaderGraph).resolveCurrent({
  paper_id: 'paper:local:6031c6453c5d413460d6', slug: 'aiinfra_training', left: 'E:/fake/aiinfra_training.pdf',
})?.paperId, 'paper:local:6031c6453c5d413460d6')

assert.equal(createPaperGraphAdapter({ schema_version: 'not-paper-network-v1', nodes: [{
  id: 'paper:wrong', type: 'paper', metadata: { paper_id: 'paper:wrong', reader_slugs: ['beta-old'], pdf_en: 'E:/fake/beta.en.pdf' },
}] }).paperBySlug('beta-old'), undefined)

console.log('PASS paper graph adapter: stable current identity, conflicts, legacy queue, live read overlay')
