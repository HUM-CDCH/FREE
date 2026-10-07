/**
 * A disposable database holding FREE's history as it stood before migration `20261001T1432_schema_revision_record_scope`:
 * provisioned fresh, migrated by the real runner to the migration before it, seeded with raw SQL (the current contract
 * types `recordScope`, which that schema does not have), then migrated forward. Shared by the db history check and the
 * extraction read-path/admission check. It never imports `./prisma/db.js`, so a caller can still point `DATABASE_URL`
 * at the provisioned database before anything binds the domain pool.
 */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

export const RECORD_SCOPE_MIGRATION = '20261001T1432_schema_revision_record_scope'
const packageRoot = resolve(import.meta.dirname, '..')

/** Drops and recreates `name` beside the server `baseUrl` names; returns its URL and how to drop it again. */
export async function provisionDatabase(baseUrl: string, name: string) {
  const target = validateDisposableTestDatabaseTarget(baseUrl)
  target.pathname = `/${name}`
  const url = validateDisposableTestDatabaseTarget(target.toString()).toString()
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const admin = async (sql: string) => {
    const client = new Client({ connectionString: maintenance.toString() })
    await client.connect()
    try { await client.query(sql) } finally { await client.end() }
  }
  await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin(`CREATE DATABASE "${name}"`)
  return { url, drop: () => admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) }
}

/** The real migration runner (`prisma-next migrate`), to `to` or to the head. */
export async function migrate(url: string, to?: string): Promise<{ applied: string[] }> {
  validateDisposableTestDatabaseTarget(url)
  const { stdout } = await promisify(execFile)(
    resolve(packageRoot, 'node_modules/.bin/prisma-next'),
    ['migrate', '--yes', '--json', '--no-color', '--db', url, ...(to ? ['--to', to] : [])],
    { cwd: packageRoot, env: { ...process.env, DATABASE_URL: url }, maxBuffer: 16 * 1024 * 1024 },
  )
  const report = JSON.parse(stdout) as { ok: boolean; applied: Array<{ dirName: string; operationsExecuted: number }> }
  if (!report.ok) throw new Error(`prisma-next migrate failed: ${stdout}`)
  const applied = report.applied.map((migration) => migration.dirName)
  return { applied }
}

export async function recordScopeColumnExists(client: Client): Promise<boolean> {
  return (await client.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schemaRevision' AND column_name = 'recordScope') AS ok`)).rows[0].ok
}

type Step = { sql: string; params?: unknown[] }
type Operation = { operationClass: string; precheck: Step[]; execute: Step[]; postcheck: Step[] }
/** The migration's own data operation, from its `ops.json`. */
export function recordScopeDataOperation(): Operation {
  const operations = JSON.parse(readFileSync(
    resolve(packageRoot, 'migrations/app', RECORD_SCOPE_MIGRATION, 'ops.json'), 'utf8')) as Operation[]
  return operations.find((operation) => operation.operationClass === 'data')!
}

/** The rows the release must leave byte for byte: every column of every history table (`::text` of the row as stored),
 *  and every Schema Revision column except the new one. */
export async function snapshotHistory(client: Client): Promise<Record<string, string[]>> {
  const rows = async (sql: string) => (await client.query<{ row: string }>(sql)).rows.map((row) => row.row)
  const table = (name: string) => rows(`SELECT row_to_json(t)::text AS row FROM "${name}" t ORDER BY id`)
  return {
    schemaRevision: await rows(`SELECT json_build_array(id, "extractionSchemaId", "revisionNumber", origin, "createdAt",
      "modelAttribution"::text, "schemaTree"::text)::text AS row FROM "schemaRevision" ORDER BY id`),
    extraction: await table('extraction'),
    batchExtraction: await table('batchExtraction'),
    extractionReview: await table('extractionReview'),
    reviewDecision: await table('reviewDecision'),
  }
}

export type HistoricalDecision = Readonly<{
  resultPath: (string | number)[]
  evidenceAnchorId: string
  reviewedOccurrenceIds: string[]
  action: 'APPROVED' | 'EDITED' | 'REJECTED'
  reviewedValue: unknown
}>
export type HistoryOptions = Readonly<{
  /** The decision digest finalization stored for these decisions. */
  digestOf?: (decisions: readonly HistoricalDecision[]) => string
  /** A Batch Extraction's identity as admission derived it for a reused selection. */
  batchIdOf?: (batch: { projectContextId: string; schemaRevisionId: string; strategy: string; sourceDocumentIds: string[]; method: unknown }) => string
  /** A batch member's Extraction ID as admission derived it. */
  memberIdOf?: (batchExtractionId: string, sourceDocumentId: string) => string
}>

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 20, 10, minutes)).toISOString()
const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value))

export const ARTICLE_TREE = {
  recordDescription: 'One article.',
  schemaNodes: [
    { id: 'title-node', name: 'title', type: 'string' },
    { id: 'authors-node', name: 'authors', type: 'array', itemType: 'string' },
  ],
}
export const CATALOG_TREE = {
  recordDescription: 'One catalogue entry.',
  schemaNodes: [{ id: 'name-node', name: 'name', type: 'string' }],
}
/** A version 1 (pre-scope) Article result: two root records, which today's document scope would refuse to accept. */
export const ARTICLE_RESULT = { records: [{ title: 'Alpha', authors: ['Ada', 'Bo'] }, { title: 'Beta', authors: [] }] }
export const ARTICLE_EVIDENCE = [
  { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_s1' },
  { resultPath: ['records', 0, 'authors', 0], evidenceAnchorId: 'a_s2', verbatim: true, lexicalHits: 1 },
  { resultPath: ['records', 1, 'title'], evidenceAnchorId: 'a_s3', linkedBy: 'lexical' },
]
export const ARTICLE_OCCURRENCES: Record<string, string[]> = { a_s1: ['o1', 'o2'], a_s2: ['o3'], a_s3: ['o4'] }
/** The latest finalized review of the Article Extraction. */
export const ARTICLE_DECISIONS: HistoricalDecision[] = [
  { resultPath: ['records', 0, 'authors', 0], evidenceAnchorId: 'a_s2', reviewedOccurrenceIds: ['o3'], action: 'APPROVED', reviewedValue: null },
  { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_s1', reviewedOccurrenceIds: ['o1', 'o2'], action: 'EDITED', reviewedValue: 'Alpha (ed.)' },
  { resultPath: ['records', 1, 'title'], evidenceAnchorId: 'a_s3', reviewedOccurrenceIds: ['o4'], action: 'REJECTED', reviewedValue: null },
]
const ARTICLE_FIRST_DECISIONS: HistoricalDecision[] = ARTICLE_DECISIONS.map((decision) =>
  ({ ...decision, action: 'APPROVED', reviewedValue: null }))
export const CATALOG_RESULT = { records: [{ name: 'Anchor' }, { name: 'Bell' }, { name: 'Cog' }] }
export const CATALOG_EVIDENCE = CATALOG_RESULT.records.map((_, index) =>
  ({ resultPath: ['records', index, 'name'], evidenceAnchorId: `a_c${index}` }))
/** The finalized review of the reviewed Catalog batch member. */
export const CATALOG_DECISIONS: HistoricalDecision[] = [
  { resultPath: ['records', 0, 'name'], evidenceAnchorId: 'a_c0', reviewedOccurrenceIds: ['c0'], action: 'EDITED', reviewedValue: 'Anchor (iron)' },
  { resultPath: ['records', 1, 'name'], evidenceAnchorId: 'a_c1', reviewedOccurrenceIds: ['c1'], action: 'REJECTED', reviewedValue: null },
  { resultPath: ['records', 2, 'name'], evidenceAnchorId: 'a_c2', reviewedOccurrenceIds: ['c2'], action: 'APPROVED', reviewedValue: null },
]
const ATTRIBUTION = { provider: 'kei-exp', modelId: 'nuextract-3', generation: { finishReason: 'stop', inputTokens: 812, outputTokens: 64, durationMs: 1400 } }
const DIAGNOSTICS = { warnings: ['one value had two candidate anchors'], grounding: { linked: 3, unlinked: 0 } }

export type History = Awaited<ReturnType<typeof seedPreMigrationHistory>>

/**
 * Seeds, through `client` and the pre-migration schema, one Researcher's history: an Article revision with a finished,
 * reviewed Extraction (two review revisions), a failed one admitted before settings were recorded and one in flight; a
 * Catalog revision run interactively (a saved, unfinalized draft); a Catalog revision run as a Batch Extraction
 * (reviewed, failed and cancelled members); an ambiguous revision run as both; a never-run revision; and an Article
 * revision a test later declares `records`.
 */
export async function seedPreMigrationHistory(client: Client, options: HistoryOptions = {}) {
  const digestOf = options.digestOf ?? ((decisions) => JSON.stringify(decisions))
  const batchIdOf = options.batchIdOf ?? (() => randomUUID())
  const memberIdOf = options.memberIdOf ?? (() => randomUUID())
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row)
    await client.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(row),
    )
  }
  const accountId = randomUUID()
  await insert('researcherAccount', { id: accountId, tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Record scope history', updatedAt: at(0) })
  const projectContextId = randomUUID()
  await insert('projectContext', { id: projectContextId, name: 'Record scope history', researcherAccountId: accountId })
  const documents: Array<{ sourceDocumentId: string; sourceRepresentationRevisionId: string }> = []
  for (const [index, name] of ['article.pdf', 'catalogue-a.pdf', 'catalogue-b.pdf', 'catalogue-c.pdf'].entries()) {
    const sourceDocumentId = randomUUID()
    const sourceRepresentationRevisionId = randomUUID()
    await insert('sourceDocument', { id: sourceDocumentId, projectContextId, contentSha256: randomBytes(32).toString('hex'), mediaType: 'application/pdf', originalName: name })
    const artifact = randomBytes(32).toString('hex')
    await insert('sourceRepresentationRevision', {
      id: sourceRepresentationRevisionId, sourceDocumentId, revisionNumber: 1, artifactReference: artifact, artifactSha256: artifact,
      contractVersion: 'parsed_document.v2', preprocessId: `kei-exp:run-${index}:g1`, parserName: 'kei-exp', parserVersion: '1',
    })
    documents.push({ sourceDocumentId, sourceRepresentationRevisionId })
  }
  const [d1, d2, d3, d4] = documents as [typeof documents[0], typeof documents[0], typeof documents[0], typeof documents[0]]
  /** One Extraction Schema per case, so each revision is its schema's current one. */
  const revision = async (name: string, tree: unknown, extra: Record<string, unknown> = {}) => {
    const extractionSchemaId = randomUUID()
    await insert('extractionSchema', { id: extractionSchemaId, projectContextId, name })
    const id: string = randomUUID()
    await insert('schemaRevision', { id, extractionSchemaId, revisionNumber: 1, origin: 'RESEARCHER_EDIT', schemaTree: json(tree), ...extra })
    return id
  }
  const revisions = {
    article: await revision('Article', ARTICLE_TREE, { origin: 'SUGGESTION', modelAttribution: json({ provider: 'kei-exp', modelId: 'qwen' }) }),
    catalog: await revision('Catalog', CATALOG_TREE),
    catalogBatch: await revision('Catalog batch', CATALOG_TREE),
    both: await revision('Both', ARTICLE_TREE),
    never: await revision('Never run', ARTICLE_TREE),
    disagree: await revision('Declared later', ARTICLE_TREE),
  }
  const extraction = async (row: Record<string, unknown>) => {
    const id = (row.id as string | undefined) ?? randomUUID()
    await insert('extraction', {
      catalogRecipe: null, requestedModels: null, outcome: null, complete: null, modelAttribution: null, diagnostics: null,
      failure: null, resultPayload: null, evidenceLinks: null, reviewable: false, reviewedAt: null, reviewDraft: null,
      reviewDraftVersion: 0, batchExtractionId: null, ...row, id,
    })
    return id
  }
  const review = async (extractionId: string, revisionNumber: number, decisions: readonly HistoricalDecision[], createdAt: string) => {
    const id: string = randomUUID()
    await insert('extractionReview', { id, extractionId, revisionNumber, decisionDigest: digestOf(decisions), createdAt })
    for (const decision of decisions)
      await insert('reviewDecision', {
        id: randomUUID(), extractionReviewId: id, resultPath: json(decision.resultPath), resultPathKey: JSON.stringify(decision.resultPath),
        evidenceAnchorId: decision.evidenceAnchorId, reviewedOccurrenceIds: json(decision.reviewedOccurrenceIds), action: decision.action,
        reviewedValue: decision.reviewedValue === null ? null : JSON.stringify({ value: decision.reviewedValue }), createdAt,
      })
  }
  const succeeded = (result: unknown, evidence: unknown) => ({
    outcome: 'SUCCEEDED', complete: true, modelAttribution: json(ATTRIBUTION), diagnostics: json(DIAGNOSTICS),
    resultPayload: json(result), evidenceLinks: json(evidence), reviewable: true,
  })
  const pins = (document: typeof d1, schemaRevisionId: string) => ({
    sourceDocumentId: document.sourceDocumentId, sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId,
  })
  const ARTICLE_SETTINGS = { article: null }
  const article = {
    failed: await extraction({
      ...pins(d1, revisions.article), strategy: 'ARTICLE', createdAt: at(1), outcome: 'FAILED',
      // Admitted before settings were recorded.
      failure: json({ code: 'extraction_failed', message: 'The model call failed.', phase: 'extracting' }),
    }),
    reviewed: await extraction({
      ...pins(d1, revisions.article), ...succeeded(ARTICLE_RESULT, ARTICLE_EVIDENCE), strategy: 'ARTICLE', createdAt: at(2),
      requestedModels: json({ fields: 'nuextract' }), requestedSettings: json(ARTICLE_SETTINGS), reviewedAt: at(5), reviewDraftVersion: 2,
    }),
    inFlight: await extraction({
      ...pins(d4, revisions.article), strategy: 'ARTICLE', createdAt: at(6), requestedSettings: json(ARTICLE_SETTINGS),
    }),
  }
  await review(article.reviewed, 1, ARTICLE_FIRST_DECISIONS, at(3))
  await review(article.reviewed, 2, ARTICLE_DECISIONS, at(5))
  const CATALOG_RECIPE = 'numbered-catalogue-de@1'
  const catalog = await extraction({
    ...pins(d2, revisions.catalog), ...succeeded(CATALOG_RESULT, CATALOG_EVIDENCE), complete: false, strategy: 'CATALOG',
    catalogRecipe: CATALOG_RECIPE, requestedSettings: json({ recipe: null }), createdAt: at(7), reviewDraftVersion: 3,
    reviewDraft: json([{ ...CATALOG_DECISIONS[0] }]),
  })
  const GENERIC = { models: null, settings: { generic: null } }
  const batch = async (schemaRevisionId: string, members: typeof documents, createdAt: string) => {
    const sourceDocumentIds = members.map((member) => member.sourceDocumentId).sort((left, right) => left.localeCompare(right))
    const id = batchIdOf({ projectContextId, schemaRevisionId, strategy: 'CATALOG', sourceDocumentIds, method: GENERIC })
    await insert('batchExtraction', { id, projectContextId, schemaRevisionId, strategy: 'CATALOG', requestedModels: null, requestedSettings: json(GENERIC.settings), createdAt })
    return id
  }
  const member = (batchExtractionId: string, document: typeof d1, schemaRevisionId: string, row: Record<string, unknown>) => extraction({
    id: memberIdOf(batchExtractionId, document.sourceDocumentId), ...pins(document, schemaRevisionId), strategy: 'CATALOG',
    batchExtractionId, requestedSettings: json(GENERIC.settings), ...row,
  })
  const catalogBatch = await batch(revisions.catalogBatch, [d2, d3, d4], at(8))
  const catalogMembers = {
    reviewed: await member(catalogBatch, d2, revisions.catalogBatch, { ...succeeded(CATALOG_RESULT, CATALOG_EVIDENCE), createdAt: at(8), reviewedAt: at(9), reviewDraftVersion: 1 }),
    failed: await member(catalogBatch, d3, revisions.catalogBatch, { createdAt: at(8), outcome: 'FAILED', failure: json({ code: 'catalog_no_records', message: 'No records were found.', phase: 'extracting' }) }),
    cancelled: await member(catalogBatch, d4, revisions.catalogBatch, { createdAt: at(8), outcome: 'CANCELLED', failure: json({ code: 'cancelled', message: 'The Extraction was cancelled.', phase: 'extracting' }) }),
  }
  await review(catalogMembers.reviewed, 1, CATALOG_DECISIONS, at(9))
  const bothArticle = await extraction({
    ...pins(d1, revisions.both), ...succeeded(ARTICLE_RESULT, ARTICLE_EVIDENCE), strategy: 'ARTICLE', createdAt: at(10),
    requestedSettings: json(ARTICLE_SETTINGS),
  })
  const bothBatch = await batch(revisions.both, [d2, d3], at(11))
  const bothMembers = [
    await member(bothBatch, d2, revisions.both, { ...succeeded(CATALOG_RESULT, CATALOG_EVIDENCE), createdAt: at(11) }),
    await member(bothBatch, d3, revisions.both, { ...succeeded({ records: [] }, []), createdAt: at(11) }),
  ]
  const disagree = await extraction({
    ...pins(d3, revisions.disagree), ...succeeded(ARTICLE_RESULT, ARTICLE_EVIDENCE), strategy: 'ARTICLE', createdAt: at(12),
    requestedSettings: json(ARTICLE_SETTINGS),
  })
  return {
    accountId, projectContextId, documents: { d1, d2, d3, d4 }, revisions, catalogRecipe: CATALOG_RECIPE,
    extractions: { article, catalog, catalogMembers, bothArticle, bothMembers, disagree },
    batches: { catalog: catalogBatch, both: bothBatch },
    methods: { article: { models: null, settings: ARTICLE_SETTINGS }, articleWithModels: { models: { fields: 'nuextract' }, settings: ARTICLE_SETTINGS }, generic: GENERIC },
  }
}
