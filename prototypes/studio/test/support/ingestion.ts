import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createInternalProjectWorkerStore,
  createModelConfigurationStore,
  createResearcherProjectStore,
  db,
  type CanonicalPackageStore,
  type ResearcherProjectStore,
} from 'db'
import { packCanonicalPackage } from '../../../../packages/db/src/artifact-store.js'
import type { IngestionStore } from '../../api/_ingestion_workflow.js'
import { keiExpManifestSchema, listedPages, parsedDocumentFromKeiExp, verifiedPage } from '../../api/_kei_exp.js'
import { EMPTY_MODEL_CONFIG } from '../../api/_model_config.js'

const FIXTURE = resolve(import.meta.dirname, '../fixtures/kei-exp')

export type IngestionOwner = Readonly<{ owner: string; store: ResearcherProjectStore }>

/** A researcher account and its own Project Context store, written through `db` on DATABASE_URL. */
export async function seedOwner(): Promise<IngestionOwner> {
  const owner = randomUUID()
  await db.orm.public.ResearcherAccount.create({
    id: owner, tenantId: '91000000-0000-4000-8000-000000000003', objectId: owner, displayName: 'Ingestion test researcher',
  })
  return { owner, store: createResearcherProjectStore(owner) }
}

/**
 * The owner's store as ingestSource publishes through it, with discards aimed at the test's own package root: the
 * researcher store's discard removes from the default package root, which holds the developer's own packages.
 */
export function ingestionStoreFor(packages: CanonicalPackageStore): (owner: string) => IngestionStore {
  const worker = createInternalProjectWorkerStore(db, { packages })
  return (owner) => ({
    ...createResearcherProjectStore(owner),
    async discardCanonicalPackage(descriptor) {
      await packages.remove(descriptor, () => worker.isPackageReferenced(descriptor.artifactReference))
    },
  })
}

/** Removes the account; its projects cascade their Source Documents. */
export async function removeOwner(owner: string): Promise<void> {
  await db.orm.public.ProjectContext.where({ researcherAccountId: owner }).deleteCount()
  await db.orm.public.ResearcherAccount.where({ id: owner }).delete()
}

/** Saves the owner's Ingestion Model Choice, as an Apply of the model configuration page would. */
export async function chooseIngestionModels(owner: string, ingestionModels: { ocr?: string; layout?: string }): Promise<void> {
  await createModelConfigurationStore().apply(owner, (previous) => ({
    ...(previous as typeof EMPTY_MODEL_CONFIG | null ?? EMPTY_MODEL_CONFIG),
    ingestionModels,
  }))
}

/** `POST …/source-documents` with one PDF, as the browser sends it. */
export function uploadRequest(projectContextId: string, pdf: Uint8Array, name = 'upload.pdf'): Request {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(pdf)], name, { type: 'application/pdf' }))
  form.append('layout', 'pages')
  return new Request(`http://studio.test/api/project-contexts/${projectContextId}/source-documents`, {
    method: 'POST', body: form,
  })
}

/** Publishes `pdf` as kei's fixture parse straight through the store, as another attempt that finished would. */
export async function publishFixtureParse(
  packages: CanonicalPackageStore,
  store: ResearcherProjectStore,
  projectContextId: string,
  pdf: Uint8Array,
) {
  const manifest = keiExpManifestSchema.parse(JSON.parse(await readFile(resolve(FIXTURE, 'result.json'), 'utf8')))
  const pages = await Promise.all(listedPages(manifest).map(async (number) =>
    verifiedPage(manifest, number, new Uint8Array(await readFile(resolve(FIXTURE, 'pages', `${number}.json`))))))
  const contentSha256 = createHash('sha256').update(pdf).digest('hex')
  const runId = `published-${randomUUID()}`
  const translated = parsedDocumentFromKeiExp(
    runId,
    { ...manifest, recipe: { ...manifest.recipe, source_sha256: contentSha256 } },
    pages,
    { sha256: contentSha256, originalFilename: 'published.pdf', byteSize: pdf.byteLength },
    new Date(),
  )
  const saved = await packages.save(packCanonicalPackage({ pdf, document: translated.document, markdown: translated.markdown }))
  const published = await store.ingestSourceDocument(projectContextId, {
    contentSha256, mediaType: 'application/pdf', originalName: 'published.pdf',
    artifactReference: saved.artifactReference, artifactSha256: saved.artifactSha256,
    contractVersion: 'parsed_document.v2', preprocessId: translated.document.preprocessing.preprocess_id,
    parserName: 'kei-exp', parserVersion: 'fixture', ensureRetained: async () => {},
  })
  if (!published) throw new Error('The fixture parse was not published.')
  return published
}
