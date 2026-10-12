/**
 * Paper-network identity adapter shared by the reader bridge and host tools.
 *
 * It deliberately contains no runtime-file writes.  Runtime JSON remains the
 * bridge's responsibility; this module only resolves a reader selection to a
 * stable graph paper and derives the live read overlay.
 */

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function strings(value) {
  return Array.isArray(value) ? value.map(nonEmptyString).filter((item) => item !== undefined) : []
}

function normalizePath(value) {
  const path = nonEmptyString(value)
  return path === undefined ? undefined : path.replaceAll('/', '\\').toLowerCase()
}

function paths(value) {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const unique = new Map()
  for (const item of values) {
    const path = nonEmptyString(item)
    if (path !== undefined) unique.set(normalizePath(path), path)
  }
  return [...unique.values()]
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (/^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value))
}

function graphPath(value, vaultRoot) {
  const path = nonEmptyString(value)
  const root = nonEmptyString(vaultRoot)
  if (path === undefined || root === undefined || isAbsolutePath(path)) return path
  return `${root.replace(/[\\/]+$/, '')}\\${path.replaceAll('/', '\\')}`
}

function assetRole(asset) {
  const explicit = Object.prototype.hasOwnProperty.call(asset, 'role')
  // `role` is the corrected graph contract. A present but invalid role is
  // deliberately not repaired from historical `recorded_role`.
  return {
    explicit,
    role: explicit ? nonEmptyString(asset.role) : nonEmptyString(asset.recorded_role),
  }
}

function assetAliasesFor(asset, vaultRoot) {
  const path = nonEmptyString(asset.path)
  return paths([path, nonEmptyString(asset.raw_path), graphPath(path, vaultRoot)])
}

/**
 * Metadata `pdf_en`/`pdf_zh` is retained for legacy graphs, but cannot
 * override a corrected explicit asset role for the same file. Matching uses
 * every recorded representation: raw_path, graph path, and vault-resolved
 * graph path. Role-absent records keep the prior metadata-compatible behavior.
 */
function metadataPathAllowed(path, assets, expectedRole, vaultRoot) {
  const candidateAliases = new Set(paths([path, graphPath(path, vaultRoot)]).map(normalizePath))
  for (const raw of assets) {
    const asset = object(raw)
    if (![...assetAliasesFor(asset, vaultRoot)].some((alias) => candidateAliases.has(normalizePath(alias)))) continue
    const { explicit, role } = assetRole(asset)
    // `available: false` is an explicit graph fact, not a failed local
    // lookup. Do not let stale metadata advertise a missing original or
    // translation. Absence of this field retains historical compatibility.
    if (asset.available === false) return false
    if (explicit && role !== expectedRole) return false
  }
  return true
}

function metadataPaths(value, assets, expectedRole, vaultRoot) {
  return paths(paths(value)
    .filter((path) => metadataPathAllowed(path, assets, expectedRole, vaultRoot))
    .map((path) => graphPath(path, vaultRoot)))
}

function assetRecords(value, expectedRole, vaultRoot, { includeUnavailable = false } = {}) {
  const unique = new Map()
  const records = Array.isArray(value) ? value : []
  for (const raw of records) {
    const asset = object(raw)
    // `role` is the normalized, corrected graph contract.  `recorded_role`
    // is historical provenance and may preserve a known earlier mistake; use
    // it only when the normalized field is truly absent.  An explicit invalid
    // normalized role must fail closed rather than falling back to history.
    const { role } = assetRole(asset)
    if (role !== expectedRole) continue
    if (!includeUnavailable && asset.available === false) continue
    const path = nonEmptyString(asset.path)
    const rawPath = nonEmptyString(asset.raw_path)
    if (path === undefined && rawPath === undefined) continue
    // Only an already-absolute raw_path can become the returned openable
    // path. A vault-relative graph path is resolved deterministically through
    // the supplied vault root, while the relative spelling remains an alias.
    const key = normalizePath(rawPath ?? path)
    if (!unique.has(key)) unique.set(key, { path, rawPath, resolvedPath: graphPath(path, vaultRoot) })
  }
  return [...unique.values()]
}

function assetAliases(records) {
  return paths(records.flatMap((asset) => [asset.path, asset.resolvedPath, asset.rawPath]))
}

function preferredAssetPath(asset) {
  // Some historical `raw_path` values are themselves vault-relative.  They
  // remain lookup aliases, but an openable payload must use the explicit
  // vault-root-resolved graph path rather than returning a relative path.
  return isAbsolutePath(asset.rawPath) ? asset.rawPath : asset.resolvedPath ?? asset.path
}

function assetPathForAlias(records, value) {
  const normalized = normalizePath(value)
  if (normalized === undefined) return undefined
  const asset = records.find((record) => normalizePath(record.rawPath) === normalized
    || normalizePath(record.resolvedPath) === normalized || normalizePath(record.path) === normalized)
  return asset === undefined ? undefined : preferredAssetPath(asset)
}

function addUnique(map, key, value) {
  if (key === undefined) return
  if (!map.has(key)) {
    map.set(key, value)
  } else if (map.get(key) !== value) {
    // A collision must never choose a card silently.
    map.set(key, null)
  }
}

function fromUnique(map, key) {
  const value = key === undefined ? undefined : map.get(key)
  return value === null ? undefined : value
}

/** Normalize a legacy reader index entry without deriving read state. */
export function normalizeReaderEntry(raw, index = 0) {
  const row = object(raw)
  const slug = nonEmptyString(row.slug)
  const title = nonEmptyString(row.title) ?? slug ?? `paper-${index + 1}`
  const paperId = nonEmptyString(row.paper_id) ?? nonEmptyString(row.paperId)
  const pdfEn = nonEmptyString(row.pdf_en) ?? nonEmptyString(row.pdfEn)
  const pdfZh = nonEmptyString(row.pdf_zh) ?? nonEmptyString(row.pdfZh)
  const score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : undefined
  return { paperId, slug, title, pdfEn, pdfZh, score, read: row.read === true }
}

function normalizeGraphPaper(node, vaultRoot) {
  const record = object(node)
  const nodeType = nonEmptyString(record.type)
  if (nodeType === undefined) return undefined
  const metadata = object(record.metadata)
  const paperId = nonEmptyString(metadata.paper_id)
  if (paperId === undefined) return undefined
  const assets = Array.isArray(metadata.assets) ? metadata.assets : []
  const rawPdfEns = paths(metadata.pdf_en)
  const rawPdfZhs = paths(metadata.pdf_zh)
  const pdfEns = metadataPaths(rawPdfEns, assets, 'original', vaultRoot)
  const pdfZhs = metadataPaths(rawPdfZhs, assets, 'translation', vaultRoot)
  const originalAssets = assetRecords(metadata.assets, 'original', vaultRoot)
  const translationAssets = assetRecords(metadata.assets, 'translation', vaultRoot)
  // Unavailable originals/translations still identify old reader selections
  // and read-overlay keys, but never become an advertised openable payload.
  const originalIdentityAssets = assetRecords(metadata.assets, 'original', vaultRoot, { includeUnavailable: true })
  const translationIdentityAssets = assetRecords(metadata.assets, 'translation', vaultRoot, { includeUnavailable: true })
  const originalPaths = paths([...originalAssets.map(preferredAssetPath), ...pdfEns])
  const translationPaths = paths([...translationAssets.map(preferredAssetPath), ...pdfZhs])
  const readerSlugs = strings(metadata.reader_slugs)
  const canonicalCard = nonEmptyString(record.card)
  // A retyped source/topic/dataset is a reader item only when the migration
  // deliberately retained its full reader identity. Ordinary navigation nodes
  // therefore cannot become papers merely because they share a node type.
  if (nodeType !== 'paper' && (readerSlugs.length === 0 || pdfEns.length === 0 || canonicalCard === undefined)) return undefined
  return {
    paperId,
    nodeType,
    nodeId: nonEmptyString(record.id),
    title: nonEmptyString(record.label),
    canonicalCard,
    readerSlugs,
    pdfEns,
    pdfZhs,
    originalAssets,
    translationAssets,
    originalPaths,
    translationPaths,
    pdfAliases: paths([...pdfEns, ...pdfZhs, ...assetAliases(originalIdentityAssets), ...assetAliases(translationIdentityAssets)]),
    pdfEn: originalPaths[0],
    pdfZh: translationPaths[0],
    conceptIds: strings(metadata.concept_ids),
    taskIds: strings(metadata.task_ids),
    methodIds: strings(metadata.method_ids),
    metadata,
  }
}

/**
 * Build safe, collision-aware graph lookup maps from the V1 artifact.
 * Unknown or absent graphs are represented by an empty adapter so legacy
 * reader state continues to work while the main migration is staged.
 */
export function createPaperGraphAdapter(graph, options = {}) {
  const root = object(graph)
  const graphAvailable = root.schema_version === 'paper-network-v1'
  const nodes = graphAvailable && Array.isArray(root.nodes) ? root.nodes : []
  const nodesById = new Map()
  const papersById = new Map()
  const papersBySlug = new Map()
  const papersByPdf = new Map()
  // A false availability receipt wins across all papers and aliases. This
  // makes a contradictory graph fail closed instead of serving stale legacy
  // index paths through the bridge's fast path.
  const unavailableAssetAliases = new Set()

  for (const rawNode of nodes) {
    const node = object(rawNode)
    const nodeId = nonEmptyString(node.id)
    if (nodeId !== undefined) addUnique(nodesById, nodeId, node)
    const metadata = object(node.metadata)
    for (const rawAsset of Array.isArray(metadata.assets) ? metadata.assets : []) {
      const asset = object(rawAsset)
      if (asset.available !== false) continue
      for (const alias of assetAliasesFor(asset, nonEmptyString(options.vaultRoot))) {
        const normalized = normalizePath(alias)
        if (normalized !== undefined) unavailableAssetAliases.add(normalized)
      }
    }
    const paper = normalizeGraphPaper(node, nonEmptyString(options.vaultRoot))
    if (paper === undefined) continue
    addUnique(papersById, paper.paperId, paper)
    for (const slug of paper.readerSlugs) addUnique(papersBySlug, slug, paper)
    for (const path of paper.pdfAliases) addUnique(papersByPdf, normalizePath(path), paper)
  }

  function linkedNodes(ids) {
    return ids.map((id) => {
      const node = fromUnique(nodesById, id)
      if (node === undefined) return { id, label: undefined, card: undefined }
      return {
        id,
        type: nonEmptyString(node.type),
        label: nonEmptyString(node.label),
        card: nonEmptyString(node.card),
      }
    })
  }

  return {
    graphAvailable,
    paperById: (paperId) => fromUnique(papersById, nonEmptyString(paperId)),
    paperBySlug: (slug) => fromUnique(papersBySlug, nonEmptyString(slug)),
    paperByPdf: (path) => fromUnique(papersByPdf, normalizePath(path)),
    assetAvailabilityFor: (path) => unavailableAssetAliases.has(normalizePath(path)) ? false : undefined,
    contextFor: (paper) => {
      const concepts = linkedNodes(paper.conceptIds)
      const tasks = linkedNodes(paper.taskIds)
      const methods = linkedNodes(paper.methodIds)
      return {
        nodeType: paper.nodeType,
        networkTypes: [...new Set([paper.nodeType, ...concepts, ...tasks, ...methods]
          .map((item) => typeof item === 'string' ? item : item.type)
          .filter((item) => item !== undefined))],
        concepts,
        tasks,
        methods,
      }
    },
  }
}

function indexEntries(entries) {
  const byPaperId = new Map()
  const bySlug = new Map()
  const byPdf = new Map()
  const byTitle = new Map()
  entries.forEach((entry) => {
    addUnique(byPaperId, entry.paperId, entry)
    addUnique(bySlug, entry.slug, entry)
    addUnique(byPdf, normalizePath(entry.pdfEn), entry)
    addUnique(byPdf, normalizePath(entry.pdfZh), entry)
    addUnique(byTitle, entry.title, entry)
  })
  return {
    byPaperId: (value) => fromUnique(byPaperId, nonEmptyString(value)),
    bySlug: (value) => fromUnique(bySlug, nonEmptyString(value)),
    byPdf: (value) => fromUnique(byPdf, normalizePath(value)),
    byTitle: (value) => fromUnique(byTitle, nonEmptyString(value)),
  }
}

function stablePaper(entry, graphPaper, graph) {
  if (entry === undefined && graphPaper === undefined) return undefined
  const paperId = graphPaper?.paperId ?? entry?.paperId
  const slug = entry?.slug ?? graphPaper?.readerSlugs[0]
  const title = entry?.title ?? graphPaper?.title ?? slug
  // A graph-backed record opens its explicitly recorded original. A legacy
  // entry may retain a translation/mirror as an overlay key, never as English.
  const pdfEn = graphPaper === undefined ? entry?.pdfEn : graphPaper.pdfEn
  const pdfZh = graphPaper === undefined ? entry?.pdfZh : graphPaper.pdfZh
  // A graph item with only a recorded translation still has a stable card and
  // progress identity.  It must resolve for status/context, but deliberately
  // has no openable English payload; `buildCurrentPayload` will reject that
  // later instead of presenting the translation as an original.
  if (title === undefined || (pdfEn === undefined && graphPaper === undefined)) return undefined
  return {
    paperId,
    slug,
    title,
    pdfEn,
    pdfZh,
    progressPaths: paths([entry?.pdfEn, pdfEn]),
    score: entry?.score,
    read: entry?.read === true,
    canonicalCard: graphPaper?.canonicalCard,
    nodeType: graphPaper?.nodeType ?? 'paper',
    context: graphPaper === undefined ? undefined : graph.contextFor(graphPaper),
    legacy: graphPaper === undefined,
  }
}

function graphForEntry(entry, graph) {
  if (entry === undefined) return undefined
  return graph.paperById(entry.paperId) ?? graph.paperBySlug(entry.slug) ?? graph.paperByPdf(entry.pdfEn)
}

function entryForGraphPaper(paper, indexes) {
  if (paper === undefined) return undefined
  let entry = indexes.byPaperId(paper.paperId)
  if (entry !== undefined) return entry
  for (const slug of paper.readerSlugs) {
    entry = indexes.bySlug(slug)
    if (entry !== undefined) return entry
  }
  for (const path of paper.pdfAliases) {
    entry = indexes.byPdf(path)
    if (entry !== undefined) return entry
  }
  return undefined
}

/**
 * Resolve an open bridge record to one paper.  It follows the V1 precedence
 * (graph paper_id, graph/legacy slug, then PDF paths) and never falls back to
 * a queue pointer or a fuzzy title match.
 */
function resolveCurrentPaperPrepared(current, entries, indexes, graph) {
  const value = object(current)
  const currentPaperId = nonEmptyString(value.paper_id) ?? nonEmptyString(value.paperId)
  const currentSlug = nonEmptyString(value.slug) ?? nonEmptyString(value.readerSlug)
  const currentPdf = nonEmptyString(value.left) ?? nonEmptyString(value.pdf_en) ?? nonEmptyString(value.pdfEn)

  function resolveSignal(kind, value) {
    let graphPaper
    let entry
    if (kind === 'paper_id') {
      graphPaper = graph.paperById(value)
      entry = graphPaper === undefined ? indexes.byPaperId(value) : entryForGraphPaper(graphPaper, indexes)
    } else if (kind === 'slug') {
      graphPaper = graph.paperBySlug(value)
      entry = graphPaper === undefined ? indexes.bySlug(value) : entryForGraphPaper(graphPaper, indexes)
    } else {
      graphPaper = graph.paperByPdf(value)
      entry = graphPaper === undefined ? indexes.byPdf(value) : entryForGraphPaper(graphPaper, indexes)
    }
    const resolved = stablePaper(entry, graphPaper ?? graphForEntry(entry, graph), graph)
    if (kind !== 'pdf' || resolved === undefined || graphPaper === undefined) return resolved
    const exactEnglish = assetPathForAlias(graphPaper.originalAssets, value)
      ?? graphPaper.pdfEns.find((path) => normalizePath(path) === normalizePath(value))
    return exactEnglish === undefined ? resolved : { ...resolved, pdfEn: exactEnglish }
  }
  const supplied = [
    ['paper_id', currentPaperId],
    ['slug', currentSlug],
    ['pdf', currentPdf],
  ].filter(([, value]) => value !== undefined)
  if (supplied.length === 0) return undefined
  const resolved = supplied.map(([kind, value]) => resolveSignal(kind, value))
  // Each declared signal must resolve, and all must identify the same paper.
  if (resolved.some((paper) => paper === undefined)) return undefined
  const first = resolved[0]
  const samePaper = (paper) => {
    if (paper.paperId !== undefined && first.paperId !== undefined) return paper.paperId === first.paperId
    return paper.pdfEn === first.pdfEn
  }
  if (!resolved.every(samePaper)) return undefined
  const pdfSignalIndex = supplied.findIndex(([kind]) => kind === 'pdf')
  // Preserve an exact supplied English asset when a graph paper carries
  // multiple canonical versions; the stable identity remains the same paper.
  const selected = pdfSignalIndex < 0 ? first : { ...first, pdfEn: resolved[pdfSignalIndex].pdfEn }
  // Retain an exact legacy input path only for live-read compatibility. It is
  // not promoted to English unless the graph recorded it as an original.
  return {
    ...selected,
    progressPaths: paths([currentPdf, ...(selected.progressPaths ?? []), selected.pdfEn]),
  }
}

function resolveQueuePaperPrepared(queueId, entries, indexes, graph) {
  const id = nonEmptyString(queueId)
  let graphPaper = graph.paperById(id)
  if (graphPaper !== undefined) return stablePaper(entryForGraphPaper(graphPaper, indexes), graphPaper, graph)
  let entry = indexes.byPaperId(id)
  if (entry !== undefined) return stablePaper(entry, graphForEntry(entry, graph), graph)
  graphPaper = graph.paperBySlug(id)
  if (graphPaper !== undefined) return stablePaper(entryForGraphPaper(graphPaper, indexes), graphPaper, graph)
  entry = indexes.bySlug(id) ?? indexes.byTitle(id)
  return entry === undefined ? undefined : stablePaper(entry, graphForEntry(entry, graph), graph)
}

/**
 * Explicitly prepare a resolver for one immutable reader-index snapshot.
 * There is no hidden cache: callers decide the lifetime, so a fresh papers
 * response cannot accidentally resolve through stale identity maps.
 */
function preparedReaderPaperResolver(entries, normalizedEntryCount, graph) {
  const indexes = indexEntries(entries)
  return Object.freeze({
    entries,
    preparation: Object.freeze({ entryCount: entries.length, normalizedEntryCount, indexBuilds: 1 }),
    resolveCurrent: (current) => resolveCurrentPaperPrepared(current, entries, indexes, graph),
    resolveQueue: (queueId) => resolveQueuePaperPrepared(queueId, entries, indexes, graph),
  })
}

export function prepareReaderPaperResolver(rawEntries, graph = createPaperGraphAdapter(null)) {
  const rows = Array.isArray(rawEntries) ? rawEntries : []
  const entries = rows.map((entry, index) => normalizeReaderEntry(entry, index))
  return preparedReaderPaperResolver(entries, entries.length, graph)
}

/**
 * Prepare lookup indexes for entries normalized by the host's validated
 * `loadPapers` boundary.  The caller owns the snapshot lifetime; this does
 * not retain or cache the array.
 */
export function prepareNormalizedReaderPaperResolver(entries, graph = createPaperGraphAdapter(null)) {
  const normalized = Array.isArray(entries) ? entries : []
  return preparedReaderPaperResolver(normalized, 0, graph)
}

/** Resolve an open bridge record to one paper without retaining an implicit cache. */
export function resolveCurrentPaper(current, rawEntries, graph = createPaperGraphAdapter(null)) {
  return prepareReaderPaperResolver(rawEntries, graph).resolveCurrent(current)
}

/** Resolve an unchanged legacy queue id without rewriting the on-disk order. */
export function resolveQueuePaper(queueId, rawEntries, graph = createPaperGraphAdapter(null)) {
  return prepareReaderPaperResolver(rawEntries, graph).resolveQueue(queueId)
}

/** Live path state wins; graph/card status is intentionally not a read signal. */
export function isLiveRead(paper, state) {
  const liveState = object(state)
  const candidates = Array.isArray(paper.progressPaths) && paper.progressPaths.length > 0
    ? paper.progressPaths : [paper.pdfEn]
  for (const path of candidates) {
    const live = liveState[path]
    if (typeof live === 'boolean') return live
  }
  return paper.read === true
}

/**
 * Build the bridge payload for a resolved paper.  Both paper_id and the old
 * slug/path fields travel together, allowing legacy windows and new consumers
 * to share one current selection.
 */
export function buildCurrentPayload(paper, options = {}) {
  if (paper === undefined || paper.pdfEn === undefined) return undefined
  const payload = {
    left: paper.pdfEn,
    title: paper.title,
    ...(paper.paperId === undefined ? {} : { paper_id: paper.paperId }),
    ...(paper.slug === undefined ? {} : { slug: paper.slug }),
    ...(paper.pdfZh === undefined ? {} : { right: paper.pdfZh }),
    ...(paper.canonicalCard === undefined ? {} : { canonicalCard: paper.canonicalCard }),
    ...(paper.context === undefined ? {} : { network: paper.context }),
  }
  const page = Number.isFinite(options.page) ? options.page : undefined
  if (page !== undefined) payload.page = page
  const vault = nonEmptyString(options.vaultName)
  if (vault !== undefined && paper.canonicalCard !== undefined) {
    payload.obsidianUrl = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(paper.canonicalCard)}`
  }
  const networkViewUrl = nonEmptyString(options.networkViewUrl) ?? (paper.paperId === undefined || paper.legacy === true
    ? undefined
    : `obsidian://paper-network?vault=${encodeURIComponent(vault ?? 'llm-wiki')}&node=${encodeURIComponent(paper.paperId)}`)
  if (networkViewUrl !== undefined) payload.networkViewUrl = networkViewUrl
  return payload
}
