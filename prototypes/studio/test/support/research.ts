import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { db, type CanonicalPackageStore } from 'db'
import { packCanonicalPackage } from '../../../../packages/db/src/artifact-store.js'
import {
  keiExpManifestSchema,
  listedPages,
  parsedDocumentFromKeiExp,
  verifiedPage,
} from '../../api/_kei_exp.js'

const FIXTURE = resolve(import.meta.dirname, '../fixtures/kei-exp')
const EXTRACTION_SCHEMA = {
  recordDescription: 'One page record.',
  schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
}

export type SeededResearch = Readonly<{
  researcherAccountId: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  extractionSchemaId: string
  schemaRevisionId: string
  /** The kei run the revision was made from, as its `preprocessId` names it. */
  runId: string
  generation: string
}>

/**
 * One researcher's project with a Source Document whose revision 1 is kei's fixture run (test/fixtures/kei-exp)
 * translated and packaged as ingestion does, so its `preprocessId` is `kei-exp:<run>:<generation>`, and an Extraction
 * Schema with one revision. Written through `db`'s ORM on DATABASE_URL; the package goes to `packages`.
 */
export async function seedResearch(packages: CanonicalPackageStore): Promise<SeededResearch> {
  const manifest = keiExpManifestSchema.parse(JSON.parse(await readFile(resolve(FIXTURE, 'result.json'), 'utf8')))
  const pages = await Promise.all(
    listedPages(manifest).map(async (number) =>
      verifiedPage(manifest, number, new Uint8Array(await readFile(resolve(FIXTURE, 'pages', `${number}.json`)))),
    ),
  )
  // The run parsed this upload: kei records its hash, which the package's Source Document must carry.
  const pdf = new TextEncoder().encode(`%PDF-1.7\n% FREE seedResearch ${randomUUID()}\n`)
  const sourceSha256 = createHash('sha256').update(pdf).digest('hex')
  const runId = `seed-${randomUUID()}`
  const translated = parsedDocumentFromKeiExp(
    runId,
    { ...manifest, recipe: { ...manifest.recipe, source_sha256: sourceSha256 } },
    pages,
    { sha256: sourceSha256, originalFilename: 'main.pdf', byteSize: pdf.byteLength },
    new Date(),
  )
  const saved = await packages.save(packCanonicalPackage({ pdf, document: translated.document, markdown: translated.markdown }))

  const researcherAccountId = randomUUID()
  const projectContextId = randomUUID()
  const sourceDocumentId = randomUUID()
  const sourceRepresentationRevisionId = randomUUID()
  const extractionSchemaId = randomUUID()
  const schemaRevisionId = randomUUID()
  await db.orm.public.ResearcherAccount.create({
    id: researcherAccountId,
    tenantId: '91000000-0000-4000-8000-000000000002',
    objectId: researcherAccountId,
    displayName: 'Workflow test researcher',
  })
  await db.orm.public.ProjectContext.create({ id: projectContextId, researcherAccountId, name: 'Workflow test' })
  await db.orm.public.SourceDocument.create({
    id: sourceDocumentId,
    projectContextId,
    contentSha256: sourceSha256,
    mediaType: 'application/pdf',
    originalName: 'main.pdf',
  })
  const preprocessId = translated.document.preprocessing.preprocess_id
  await db.orm.public.SourceRepresentationRevision.create({
    id: sourceRepresentationRevisionId,
    sourceDocumentId,
    revisionNumber: 1,
    artifactReference: saved.artifactReference,
    artifactSha256: saved.artifactSha256,
    contractVersion: 'parsed_document.v2',
    preprocessId,
    parserName: 'kei-exp',
    parserVersion: 'fixture',
  })
  await db.orm.public.ExtractionSchema.create({ id: extractionSchemaId, projectContextId, name: 'Workflow test schema' })
  await db.orm.public.SchemaRevision.create({
    id: schemaRevisionId,
    extractionSchemaId,
    revisionNumber: 1,
    origin: 'RESEARCHER_EDIT',
    schemaTree: EXTRACTION_SCHEMA,
  })
  return {
    researcherAccountId,
    projectContextId,
    sourceDocumentId,
    sourceRepresentationRevisionId,
    extractionSchemaId,
    schemaRevisionId,
    runId,
    generation: manifest.generation,
  }
}

/** Removes what seedResearch wrote: the project cascades its documents, schemas and Extractions. */
export async function removeResearch(seeded: SeededResearch): Promise<void> {
  await db.orm.public.ProjectContext.where({ id: seeded.projectContextId }).delete()
  await db.orm.public.ResearcherAccount.where({ id: seeded.researcherAccountId }).delete()
}
