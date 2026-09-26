import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import {
  createInternalProjectWorkerStore,
  createResearcherProjectStore,
  db,
  workflowStatusesOf,
  type CanonicalPackageStore,
} from 'db'
import { dbosSteps } from 'extraction'
import { packCanonicalPackage } from '../../../../packages/db/src/artifact-store.js'
import {
  workerSuggestionStore,
  type SuggestionStore,
  type SuggestionWorkflowPorts,
} from '../../api/_batch_suggestion_workflow.js'
import { studioDbos } from '../../server/dbos.js'

/** What each fake source suggestion and the fake merge answer: one common field, so the merge verifies. */
const TEMPLATE = { _description: 'One article.', title: 'string' }

export type SeededSuggestionSources = Readonly<{
  researcherAccountId: string
  projectContextId: string
  /** Sorted by Source Document ID, as admission pins them; each one's Markdown is `# Source <letter>`. */
  sources: ReadonlyArray<{ letter: string; sourceDocumentId: string; sourceRepresentationRevisionId: string }>
}>

/**
 * One researcher's project with a Source Document per letter, each with one revision whose canonical package's
 * Markdown is `# Source <letter>`, so a fake model can tell the sources apart. Written through `db` on DATABASE_URL;
 * the packages go to `packages`.
 */
export async function seedSuggestionSources(
  packages: CanonicalPackageStore,
  letters: readonly string[],
): Promise<SeededSuggestionSources> {
  const researcherAccountId = randomUUID()
  const projectContextId = randomUUID()
  await db.orm.public.ResearcherAccount.create({
    id: researcherAccountId,
    tenantId: '91000000-0000-4000-8000-000000000003',
    objectId: researcherAccountId,
    displayName: 'Suggestion workflow researcher',
  })
  await db.orm.public.ProjectContext.create({ id: projectContextId, researcherAccountId, name: 'Suggestion workflow' })
  const sources = []
  for (const letter of letters) {
    const pdf = new TextEncoder().encode(`%PDF-1.7\n% Source ${letter} ${randomUUID()}\n`)
    const sha = createHash('sha256').update(pdf).digest('hex')
    const preprocessId = `suggestion-test-${randomUUID()}`
    const saved = await packages.save(packCanonicalPackage({
      pdf,
      document: {
        schema_version: 'parsed_document.v2',
        document: { content_sha256: sha },
        preprocessing: { preprocess_id: preprocessId },
      },
      markdown: `# Source ${letter}`,
    }))
    const sourceDocumentId = randomUUID()
    const sourceRepresentationRevisionId = randomUUID()
    await db.orm.public.SourceDocument.create({
      id: sourceDocumentId,
      projectContextId,
      ingestionKey: randomUUID(),
      contentSha256: sha,
      mediaType: 'application/pdf',
      originalName: `${letter}.pdf`,
    })
    await db.orm.public.SourceRepresentationRevision.create({
      id: sourceRepresentationRevisionId,
      sourceDocumentId,
      revisionNumber: 1,
      artifactReference: saved.artifactReference,
      artifactSha256: saved.artifactSha256,
      contractVersion: 'parsed_document.v2',
      preprocessId,
      parserName: 'test',
      parserVersion: '1',
    })
    sources.push({ letter, sourceDocumentId, sourceRepresentationRevisionId })
  }
  sources.sort((left, right) => left.sourceDocumentId.localeCompare(right.sourceDocumentId))
  return { researcherAccountId, projectContextId, sources }
}

/** Removes what seedSuggestionSources wrote: the project cascades its documents and suggestions. */
export async function removeSuggestionSources(seeded: SeededSuggestionSources): Promise<void> {
  await db.orm.public.ProjectContext.where({ id: seeded.projectContextId }).delete()
  await db.orm.public.ResearcherAccount.where({ id: seeded.researcherAccountId }).delete()
}

/** The researcher's store, admitting and reading through this process's launched Studio DBOS (as server/app.ts does). */
export function suggestionResearcherStore(researcherAccountId: string) {
  return createResearcherProjectStore(researcherAccountId, db, {
    workflowStatuses: (workflowIds) =>
      workflowStatusesOf((input) => studioDbos().admission.listWorkflows(input))(workflowIds),
    enqueue: (client, workflow, input) =>
      studioDbos()
        .admission.enqueueInTransaction(client, { ...workflow, attributes: { ...workflow.attributes } }, input)
        .then(() => undefined),
  })
}

/** Which model call this is: a source's (its Markdown's letter) or the merge. */
export function modelCallOf(markdown: string | null | undefined): string {
  if (markdown?.startsWith('SOURCE DOCUMENT ')) return 'merge'
  const letter = /^# Source (\w+)$/.exec(markdown ?? '')?.[1]
  if (!letter) throw new Error('The fake model was given a document it does not know.')
  return `source ${letter}`
}

/** Every model call the fake answered, one line each, in order, across processes. */
export function readModelCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

/**
 * A scripted model that appends each call (`source A`, `merge`) to `log` before `before` may throw or kill the process,
 * then answers the one common field. It never calls a provider.
 */
export function scriptedGenerate(
  log: string,
  before: (call: string) => void = () => {},
): SuggestionWorkflowPorts['generate'] {
  return async (_caller, input) => {
    const call = modelCallOf(input.document.markdown)
    appendFileSync(log, `${call}\n`)
    before(call)
    return { template: TEMPLATE, raw: JSON.stringify(TEMPLATE), pages: null }
  }
}

/** suggestSchemaBatch's production ports on the real worker store (packages from `packages`), with a fake model and
 *  optional `store` overrides. */
export function suggestionPorts(
  packages: CanonicalPackageStore,
  generate: SuggestionWorkflowPorts['generate'],
  store: (worker: SuggestionStore) => SuggestionStore = (worker) => worker,
): SuggestionWorkflowPorts {
  return {
    steps: dbosSteps,
    generate,
    store: store(workerSuggestionStore(createInternalProjectWorkerStore(db, { packages }))),
  }
}
