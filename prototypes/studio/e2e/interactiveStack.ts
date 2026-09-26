import { expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ParsedDocument } from 'extraction/parsed-document'
import { createCanonicalPackageStore, packCanonicalPackage } from '../../../packages/db/src/artifact-store.js'
import { db } from '../../../packages/db/src/prisma/db.js'
import { DEVELOPMENT_ENTRA_TENANT_ID } from '../server/entraIdentityProvider.js'
import { startScriptedModelServer } from '../test/support/scriptedModelServer.js'
import { e2eStudioPath, loginResearcher } from './auth.js'

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

/** A canonical package for one of the example PDFs with the bundled parsed document, as the lifecycle spec seeds it. */
export async function canonicalPackage(
  originalFilename: string,
  sourceDocument?: ParsedDocument,
  pdfFilename = 'Beretning_Ellekilde_8_13.pdf',
) {
  const pdf = await readFile(resolve(import.meta.dirname, '../../../examples', pdfFilename))
  const sourceHash = sha256(pdf)
  const document = structuredClone(
    sourceDocument ?? JSON.parse(await readFile(resolve(import.meta.dirname, '../src/assets/parsed_document.v2.json'), 'utf8')),
  ) as ParsedDocument
  document.document.content_sha256 = sourceHash
  document.document.source.original_filename = originalFilename
  document.document.source.byte_size = pdf.byteLength
  for (const [index, anchor] of document.evidence_index.anchors.entries()) {
    anchor.content_sha256 = sourceHash
    anchor.anchor_id = `a_p1_s${index}`
  }
  return {
    bytes: packCanonicalPackage({ pdf, document, markdown: '# Article fixture\n\nGrav 8\n' }),
    sourceHash,
  }
}

export const INTERACTIVE_SCHEMA_NODES = [
  { id: 'title', name: 'title', type: 'string' },
  { id: 'year', name: 'year', type: 'integer' },
] as const

export type InteractiveDocument = {
  accountId: string
  objectId: string
  connectionId: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  /** The seeded Extraction Schema (one revision), or null when the document starts without one. */
  extractionSchemaId: string | null
  url: string
  model: Awaited<ReturnType<typeof startScriptedModelServer>>
  /** Navigates `page` to the document workspace and waits for the schema panel. */
  open(target?: Page): Promise<void>
  schemaRevisions(): Promise<readonly { schemaRevisionId: string; revisionNumber: number }[]>
  close(): Promise<void>
}

/**
 * One researcher with one ingested document and a scripted model behind both model routes, seeded the way the
 * lifecycle spec seeds its account (rows and a canonical package; no parsing service). With `hasKey`, this browser
 * holds `key` for the connection as the key store writes it, so the page hands it to Studio before model work.
 */
export async function prepareInteractiveDocument(
  page: Page,
  options: { hasKey: boolean; key?: string; schema?: 'seeded' | 'none' },
): Promise<InteractiveDocument> {
  const model = await startScriptedModelServer()
  const accountId = randomUUID()
  const objectId = randomUUID()
  const connectionId = randomUUID()
  const projectContextId = randomUUID()
  const sourceDocumentId = randomUUID()
  const sourceRepresentationRevisionId = randomUUID()
  const extractionSchemaId = options.schema === 'none' ? null : randomUUID()
  const packageStore = createCanonicalPackageStore()
  const seeded = await canonicalPackage('interactive.pdf')
  const descriptor = await packageStore.save(seeded.bytes)

  await db.orm.public.ResearcherAccount.create({
    id: accountId, tenantId: DEVELOPMENT_ENTRA_TENANT_ID, objectId, displayName: 'Interactive reload researcher',
  })
  const connection = { id: connectionId, name: 'Scripted model', provider: 'openai-compatible', baseUrl: model.baseUrl, hasKey: options.hasKey }
  await db.orm.public.ModelConfiguration.create({
    researcherAccountId: accountId,
    document: {
      connections: [connection],
      routes: {
        schemaSuggestion: { connectionId, modelId: 'scripted' },
        interaction: { connectionId, modelId: 'scripted' },
      },
      extractionModels: {},
      ingestionModels: {},
    },
  })
  await db.orm.public.ProjectContext.create({ id: projectContextId, researcherAccountId: accountId, name: 'Interactive reload E2E' })
  await db.orm.public.SourceDocument.create({
    id: sourceDocumentId, projectContextId, contentSha256: seeded.sourceHash, mediaType: 'application/pdf', originalName: 'interactive.pdf',
  })
  await db.orm.public.SourceRepresentationRevision.create({
    id: sourceRepresentationRevisionId,
    sourceDocumentId,
    revisionNumber: 1,
    artifactReference: descriptor.artifactReference,
    artifactSha256: descriptor.artifactSha256,
    contractVersion: 'parsed_document.v2',
    preprocessId: `kei-exp:e2e-${sourceRepresentationRevisionId}:g1`,
    parserName: 'fixture',
    parserVersion: '1',
  })
  if (extractionSchemaId) {
    await db.orm.public.ExtractionSchema.create({ id: extractionSchemaId, projectContextId, name: 'Interactive schema' })
    await db.orm.public.SchemaRevision.create({
      id: randomUUID(),
      extractionSchemaId,
      revisionNumber: 1,
      origin: 'RESEARCHER_EDIT',
      schemaTree: { recordDescription: 'One interactive record.', schemaNodes: INTERACTIVE_SCHEMA_NODES },
    })
  }

  const url = e2eStudioPath(`/projects/${projectContextId}/documents/${sourceDocumentId}`)
  await loginResearcher(page, objectId)
  if (options.hasKey) {
    const entry = { [connectionId]: { provider: 'openai-compatible', baseUrl: model.baseUrl, key: options.key ?? 'sk-e2e-planted' } }
    await page.evaluate(([storageKey, value]) => window.localStorage.setItem(storageKey, value), [`free.modelKeys.v1:${accountId}`, JSON.stringify(entry)])
  }

  return {
    accountId, objectId, connectionId, projectContextId, sourceDocumentId, sourceRepresentationRevisionId, extractionSchemaId, url, model,
    async open(target = page) {
      await target.goto(url)
      await expect(target).toHaveURL(url)
      await expect(target.getByText('6 pages', { exact: true })).toBeVisible({ timeout: 20_000 })
      if (extractionSchemaId) await expect(target.getByText('title', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    },
    async schemaRevisions() {
      const schemaId = extractionSchemaId
        ?? (await db.orm.public.ExtractionSchema.select('id').first({ projectContextId }))?.id
      if (!schemaId) return []
      const rows = await db.orm.public.SchemaRevision.select('id', 'revisionNumber').where({ extractionSchemaId: schemaId }).all()
      return rows
        .map((row) => ({ schemaRevisionId: row.id, revisionNumber: row.revisionNumber }))
        .sort((a, b) => a.revisionNumber - b.revisionNumber)
    },
    async close() {
      await model.close()
    },
  }
}
