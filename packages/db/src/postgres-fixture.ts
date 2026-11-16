/** Disposable PostgreSQL provisioning and current research pins for integration checks. */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

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

/** The real migration runner (`prisma-next migrate`), to `to` or to the head of `packageDirectory`'s migrations. */
export async function migrate(url: string, to?: string, packageDirectory = packageRoot): Promise<{ applied: string[] }> {
  validateDisposableTestDatabaseTarget(url)
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve(packageRoot, 'node_modules/prisma-next/dist/cli.mjs'), 'migrate', '--yes', '--json', '--no-color', '--db', url, '--to', to ?? 'db'],
    { cwd: packageDirectory, env: { ...process.env, DATABASE_URL: url }, maxBuffer: 16 * 1024 * 1024 },
  )
  const report = JSON.parse(stdout) as { ok: boolean; applied: Array<{ dirName: string; operationsExecuted: number }> }
  if (!report.ok) throw new Error(`prisma-next migrate failed: ${stdout}`)
  const applied = report.applied.map((migration) => migration.dirName)
  return { applied }
}

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 20, 10, minutes)).toISOString()
const json = (value: unknown) => JSON.stringify(value)

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
export async function seedResearchPins(client: Client) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row)
    await client.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(row),
    )
  }
  const accountId = randomUUID()
  await insert('researcherAccount', { id: accountId, tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Current research pins', updatedAt: at(0) })
  const projectContextId = randomUUID()
  await insert('projectContext', { id: projectContextId, name: 'Current research pins', researcherAccountId: accountId })
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
  /** One Extraction Schema per case, so each revision is its schema's current one. */
  const revision = async (name: string, tree: unknown, extra: Record<string, unknown> = {}) => {
    const extractionSchemaId = randomUUID()
    await insert('extractionSchema', { id: extractionSchemaId, projectContextId, name })
    const id: string = randomUUID()
    await insert('schemaRevision', { id, extractionSchemaId, revisionNumber: 1, origin: 'RESEARCHER_EDIT', schemaTree: json(tree), recordScope: name.startsWith('Catalog') ? 'records' : 'document', ...extra })
    return id
  }
  const revisions = {
    article: await revision('Article', ARTICLE_TREE, { origin: 'SUGGESTION', recordScope: 'document' }),
    catalog: await revision('Catalog', CATALOG_TREE),
    catalogBatch: await revision('Catalog batch', CATALOG_TREE),
    both: await revision('Both', ARTICLE_TREE),
    never: await revision('Never run', ARTICLE_TREE),
    disagree: await revision('Declared later', ARTICLE_TREE),
  }
  const [d1, d2, d3, d4] = documents as [typeof documents[0], typeof documents[0], typeof documents[0], typeof documents[0]]
  return { accountId, projectContextId, documents: { d1, d2, d3, d4 }, revisions }
}

/** One current public Extraction pin; tests explicitly create its coordination head when needed. */
export async function seedExtraction(client: Client, pins: Awaited<ReturnType<typeof seedResearchPins>>) {
  const id = randomUUID(), document = pins.documents.d1
  await client.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings")
    VALUES ($1,$2,$3,$4,'ARTICLE',$5)`, [id, document.sourceDocumentId, document.sourceRepresentationRevisionId, pins.revisions.article,
    { article: { context: 'full', context_tokens: 12288, overlap_passages: 0, grounding: 'semantic', grounding_overflow: 'windows' } }])
  return id
}
