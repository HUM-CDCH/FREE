/**
 * Owns admission: the identities an Extraction or a Batch Extraction is admitted under, and the transactions that
 * commit each row together with its `runExtraction` workflow on one pooled client (ADR 0012: row-backed work is
 * enqueued in the same transaction as its rows). New work pins the document's current revision under its row lock; a
 * repeated request replays, and a different one under the same identity conflicts.
 */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk'
import {
  isUniqueViolation,
  lockModelConfiguration,
  lockSourceDocumentRow,
  stableJson,
  stableUuid,
  withPoolClientTransaction,
  type Database,
  type DatabaseOrm,
  type DatabaseTransaction,
  type WorkflowStatuses,
} from 'db'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from './batch.js'
import type { ExtractionExecution } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { extractWorkflowId } from './kei-handoff.js'
import {
  accountMethod,
  canonicalIntent,
  identityFieldIssues,
  identityFieldsMessage,
  modelChoice,
  type ActiveSettings,
  type ExtractionMethodIntent,
} from './extraction-method.js'
import { readBatchForResearcher, snapshot } from './postgres-batches.js'
import { ownsResearcherExtraction } from './postgres-ownership.js'
import { parseExtractionSchema } from './schema.js'
import {
  EXTRACTION_QUEUE,
  extractionAttributes,
  RUN_EXTRACTION,
} from './workflows.js'
import type {
  ExtractionModelChoice,
  ExtractionStrategy,
  RunSingleInput,
  ScheduleBatchInput,
  ScheduleBatchResult,
} from './types.js'

const EXTRACTION_KEY = 'extraction_pkey'
const BATCH_KEY = 'batchExtraction_pkey'

export const METHOD_CHANGED_MESSAGE =
  'Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again.'

/** Whether the account's saved method, read under its configuration row's lock, is still the one the researcher saw.
 *  The comparison and the snapshot write share one transaction, so an Apply commits wholly before or after it. */
export async function savedMethodStillCurrent(
  client: Parameters<typeof lockModelConfiguration>[0],
  owner: string,
  strategy: ExtractionStrategy,
  catalogRecipe: string | null,
  method: ExtractionMethodIntent,
): Promise<boolean> {
  return isDeepStrictEqual(accountMethod(await lockModelConfiguration(client, owner), strategy, catalogRecipe), method)
}

/** Identity fields the pinned schema cannot key records by refuse the Extraction before anything is enqueued; the
 *  Parsing Service checks the same again when it runs (`ExtractRequest._identity_fields_exist`). */
export function refuseUnusableIdentityFields(settings: ActiveSettings, schemaTree: unknown): void {
  const article = 'article' in settings ? settings.article : null
  if (!article || article.identity_fields.length === 0) return
  let nodes
  try {
    nodes = parseExtractionSchema(schemaTree).schemaNodes
  } catch {
    throw new ExtractionError('invalid_extraction_pins', 'The selected Schema Revision is invalid.')
  }
  const issues = identityFieldIssues(nodes, article.identity_fields)
  if (issues.length > 0) throw new ExtractionError('invalid_identity_fields', identityFieldsMessage(issues))
}

/**
 * The statuses of work admitted just now: each workflow was enqueued in the transaction that committed its row, so it
 * is QUEUED (an outcome on the row still wins). A created admission answers with them, so a DBOS read cannot turn a
 * committed admission into a failure the client would retry with a new identity.
 */
export const JUST_ADMITTED: WorkflowStatuses = async (workflowIds) => new Map(workflowIds.map((id) => [id, 'ENQUEUED']))

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}
function selectionId(input: ScheduleBatchInput): string {
  const models = modelChoice(input.models)
  const hash = createHash('sha256')
    .update(JSON.stringify([
      input.projectContextId,
      input.schemaRevisionId,
      input.strategy,
      canonicalIds(input.sourceDocumentIds),
      ...(models === null ? [] : [models]),
    ]))
    .digest('hex')
  const variant = (['8', '9', 'a', 'b'] as const)[parseInt(hash[16]!, 16) & 3]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
/** A batch member's Extraction ID: a replayed batch admission reproduces its members (plan decision 8). */
function batchMemberExtractionId(batchExtractionId: string, sourceDocumentId: string): string {
  return stableUuid('batch-member-extraction', stableJson([batchExtractionId, sourceDocumentId]))
}

type AdmissionPins = Readonly<{
  owner: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  extractionSchemaId: string
  strategy: ExtractionStrategy
  catalogRecipe: string | null
  requestedModels: ExtractionModelChoice | null
  requestedSettings: ActiveSettings
  schemaTree: unknown
  preprocessId: string
}>

/** The pins an interactive request names, when every one of them exists and belongs to the researcher's project. */
async function resolveAdmission(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  input: RunSingleInput,
): Promise<AdmissionPins | null> {
  const { orm } = transaction
  const representation = await orm.public.SourceRepresentationRevision.select(
    'sourceDocumentId', 'preprocessId',
  ).first({ id: input.sourceRepresentationRevisionId })
  const document = representation
    ? await orm.public.SourceDocument.select('projectContextId').first({ id: representation.sourceDocumentId })
    : null
  const schema = await orm.public.SchemaRevision.select('extractionSchemaId', 'schemaTree').first({ id: input.schemaRevisionId })
  const schemaOwner = schema
    ? await orm.public.ExtractionSchema.select('projectContextId').first({ id: schema.extractionSchemaId })
    : null
  const project = document
    ? await orm.public.ProjectContext.select('researcherAccountId').first({ id: document.projectContextId })
    : null
  if (!representation || !document || !schema || !schemaOwner ||
      schemaOwner.projectContextId !== document.projectContextId ||
      !project || project.researcherAccountId !== researcherAccountId)
    return null
  const catalogRecipe = input.strategy === 'CATALOG' ? input.catalogRecipe ?? null : null
  const method = canonicalIntent(input.method, input.strategy, catalogRecipe)
  if (method === null) throw new ExtractionError('invalid_request', 'The saved method does not fit this Extraction Strategy.')
  return {
    owner: researcherAccountId,
    projectContextId: document.projectContextId,
    sourceDocumentId: representation.sourceDocumentId,
    sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
    schemaRevisionId: input.schemaRevisionId,
    extractionSchemaId: schema.extractionSchemaId,
    strategy: input.strategy,
    catalogRecipe,
    requestedModels: method.models,
    requestedSettings: method.settings,
    schemaTree: schema.schemaTree,
    preprocessId: representation.preprocessId,
  }
}

type AdmittedIdentity = Readonly<{
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: string
  catalogRecipe: string | null
  requestedModels: unknown
  requestedSettings: unknown
  batchExtractionId: string | null
}>

/** An identical interactive request: the same pins and choices. A batch member's ID is never an interactive one. */
function sameAdmission(row: AdmittedIdentity, pins: AdmissionPins): boolean {
  return row.batchExtractionId === null &&
    row.sourceDocumentId === pins.sourceDocumentId &&
    row.sourceRepresentationRevisionId === pins.sourceRepresentationRevisionId &&
    row.schemaRevisionId === pins.schemaRevisionId &&
    row.strategy === pins.strategy &&
    row.catalogRecipe === pins.catalogRecipe &&
    isDeepStrictEqual(modelChoice(row.requestedModels), pins.requestedModels) &&
    // A NULL (historical) row was admitted before settings were recorded, so it never equals a recorded method.
    isDeepStrictEqual(row.requestedSettings ?? null, pins.requestedSettings)
}

/** DBOS refused the workflow ID (workflowIDReusePolicy 'reject'): its Extraction is gone, so the ID is spent. */
function workflowIdInUse(error: unknown): boolean {
  return DBOSErrors.isWorkflowIDInUseError(error)
}

/**
 * Admits one interactive Extraction: its row and its `runExtraction` workflow commit together on one pooled client
 * (spec, *Admission: one transaction*), or neither does.
 */
export async function admitInteractiveExtraction(
  execution: ExtractionExecution,
  researcherAccountId: string,
  input: RunSingleInput,
  attempt = 0,
): Promise<'created' | 'replayed' | 'conflict' | 'superseded' | 'method-changed' | 'missing'> {
  try {
    return await withPoolClientTransaction(async (transaction, client) => {
      const pins = await resolveAdmission(transaction, researcherAccountId, input)
      if (pins === null) return 'missing'
      const identity = () => transaction.orm.public.Extraction.select(
        'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
        'requestedModels', 'requestedSettings', 'batchExtractionId',
      ).first({ id: input.extractionId })
      // Another researcher's Extraction under this ID is concealed behind the same missing answer.
      const replay = async (row: AdmittedIdentity) =>
        sameAdmission(row, pins)
          ? 'replayed' as const
          : (await ownsResearcherExtraction(transaction, researcherAccountId, input.extractionId))
              ? 'conflict' as const
              : 'missing' as const
      // Replay resolution comes first: an identical repeat replays even when its revision is superseded now (PR #140).
      const existing = await identity()
      if (existing) return replay(existing)
      // A new identity is admitted only on the document's current revision, decided under the Source Document row
      // lock that reprocess publication also takes (PR #140).
      if (!(await lockSourceDocumentRow(transaction, pins.sourceDocumentId))) return 'missing'
      // A request with this ID may have committed while this one waited for the document lock.
      const raced = await identity()
      if (raced) return replay(raced)
      const current = await transaction.orm.public.SourceRepresentationRevision.where({
        sourceDocumentId: pins.sourceDocumentId,
      }).select('id').orderBy((revision) => revision.revisionNumber.desc()).first()
      // No revision left means the document vanished while this waited for the lock.
      if (!current) return 'missing'
      if (current.id !== pins.sourceRepresentationRevisionId) return 'superseded'
      // After the replay checks: an identical repeat replays even when the account's settings changed since (design §7).
      if (!(await savedMethodStillCurrent(client, pins.owner, pins.strategy, pins.catalogRecipe,
        { models: pins.requestedModels, settings: pins.requestedSettings })))
        return 'method-changed'
      refuseUnusableIdentityFields(pins.requestedSettings, pins.schemaTree)
      await transaction.orm.public.Extraction.create({
        id: input.extractionId,
        sourceDocumentId: pins.sourceDocumentId,
        sourceRepresentationRevisionId: pins.sourceRepresentationRevisionId,
        schemaRevisionId: pins.schemaRevisionId,
        strategy: pins.strategy,
        catalogRecipe: pins.catalogRecipe,
        requestedModels: pins.requestedModels,
        requestedSettings: pins.requestedSettings,
        batchExtractionId: null,
      })
      await execution.enqueue(client, {
        workflowName: RUN_EXTRACTION,
        workflowID: extractWorkflowId(input.extractionId),
        queueName: EXTRACTION_QUEUE,
        authenticatedUser: pins.owner,
        attributes: extractionAttributes({ ...pins, batchExtractionId: null }),
      }, input.extractionId)
      return 'created'
    })
  } catch (error) {
    // A concurrent first request committed this primary key: reload and compare in a new transaction (spec, *Replays*).
    // Unrelated constraint errors are not replays.
    if (attempt === 0 && isUniqueViolation(error, EXTRACTION_KEY))
      return admitInteractiveExtraction(execution, researcherAccountId, input, 1)
    if (workflowIdInUse(error)) return 'conflict'
    throw error
  }
}

/** Identity constraints a concurrent suggested-batch handoff of the same suggestion commits first. */
export const SUGGESTED_BATCH_KEYS = [
  'extractionSchema_pkey',
  'schemaRevision_pkey',
  'schemaRevision_extractionSchemaId_revisionNumber_key',
  BATCH_KEY,
  EXTRACTION_KEY,
  'batchSchemaSuggestion_confirmedSchemaRevisionId_key',
  'batchSchemaSuggestion_batchExtractionId_key',
] as const

/**
 * Admits a Batch Extraction: the batch, one pending Extraction per selected Source Document (deterministic IDs) and
 * every member's `runExtraction` workflow commit together on one pooled client. Each member pins its document's
 * current revision under the document's row lock, taken in sorted order so batches and reprocesses never deadlock
 * (PR #140).
 */
export async function admitBatchExtraction(
  database: Database,
  execution: ExtractionExecution,
  researcherAccountId: string,
  input: ScheduleBatchInput,
): Promise<ScheduleBatchResult | null> {
  const batchExtractionId =
    input.repetition === 'create-new' ? randomUUID() : selectionId(input)
  const requestedModels = modelChoice(input.models)
  try {
    const opened = await withPoolClientTransaction(async (transaction, client) => {
      const { orm } = transaction
      if (
        !(await orm.public.ProjectContext.select('id').first({
          id: input.projectContextId,
          researcherAccountId,
        }))
      )
        return 'missing' as const
      if (
        input.sourceDocumentIds.length === 0 ||
        input.sourceDocumentIds.length > BATCH_EXTRACTION_SELECTION_LIMIT ||
        new Set(input.sourceDocumentIds).size !== input.sourceDocumentIds.length
      )
        return 'invalid' as const
      const schema =
        await orm.public.SchemaRevision.select(
          'extractionSchemaId',
        ).first({ id: input.schemaRevisionId })
      const owner = schema
        ? await orm.public.ExtractionSchema.select(
            'projectContextId',
          ).first({ id: schema.extractionSchemaId })
        : null
      if (
        !schema ||
        !owner ||
        owner.projectContextId !== input.projectContextId
      )
        return 'missing' as const
      const current = await orm.public.SchemaRevision.where({
        extractionSchemaId: schema.extractionSchemaId,
      })
        .select('id')
        .orderBy((revision) => revision.revisionNumber.desc())
        .first()
      if (current?.id !== input.schemaRevisionId)
        return 'invalid' as const
      const members: Array<{
        sourceDocumentId: string
        sourceRepresentationRevisionId: string
        preprocessId: string
      }> = []
      // canonicalIds' sorted order is the deadlock guard: batches sharing members lock alike.
      for (const sourceDocumentId of canonicalIds(
        input.sourceDocumentIds,
      )) {
        if (
          !(await orm.public.SourceDocument.select('id').first({
            id: sourceDocumentId,
            projectContextId: input.projectContextId,
          }))
        )
          return 'missing' as const
        if (!(await lockSourceDocumentRow(transaction, sourceDocumentId)))
          return 'missing' as const
        const representation =
          await orm.public.SourceRepresentationRevision.where({
            sourceDocumentId,
          })
            .select('id', 'preprocessId')
            .orderBy((revision) => revision.revisionNumber.desc())
            .first()
        if (!representation) return 'invalid' as const
        members.push({
          sourceDocumentId,
          sourceRepresentationRevisionId: representation.id,
          preprocessId: representation.preprocessId,
        })
      }
      await orm.public.BatchExtraction.create({
        id: batchExtractionId,
        projectContextId: input.projectContextId,
        schemaRevisionId: input.schemaRevisionId,
        strategy: input.strategy,
      })
      for (const member of members)
        await admitBatchMember(orm, client, execution, {
          owner: researcherAccountId,
          projectContextId: input.projectContextId,
          extractionSchemaId: schema.extractionSchemaId,
          schemaRevisionId: input.schemaRevisionId,
          strategy: input.strategy,
          requestedModels,
          batchExtractionId,
          ...member,
        })
      return 'created' as const
    })
    if (opened === 'missing') return null
    if (opened === 'invalid')
      throw new ExtractionError(
        'invalid_extraction_pins',
        'Use the Current Schema Revision and Source Documents in this Project Context with a Source Representation.',
      )
    const batch = await readBatchForResearcher(
      database,
      researcherAccountId,
      input.projectContextId,
      batchExtractionId,
      JUST_ADMITTED,
    )
    if (!batch)
      throw new Error('Persisted Batch Extraction could not be read.')
    return { disposition: 'created', batch: snapshot(batch) }
  } catch (error) {
    // The batch's primary key: an equal selection committed first. Its member rows are compared with this request.
    if (!isUniqueViolation(error, BATCH_KEY) && !workflowIdInUse(error)) throw error
    const batch = await readBatchForResearcher(
      database,
      researcherAccountId,
      input.projectContextId,
      batchExtractionId,
      execution.statuses,
    )
    const selected = canonicalIds(input.sourceDocumentIds)
    if (
      !batch ||
      batch.schemaRevisionId !== input.schemaRevisionId ||
      batch.strategy !== input.strategy ||
      batch.members.length !== selected.length ||
      !batch.members.every(
        (member, index) =>
          member.sourceDocumentId === selected[index] &&
          isDeepStrictEqual(modelChoice(member.extraction.requestedModels), requestedModels),
      )
    )
      throw new ExtractionError(
        'batch_conflict',
        'The Batch Extraction identity belongs to another selection.',
        { cause: error },
      )
    return { disposition: 'replayed', batch: snapshot(batch) }
  }
}

export type BatchMemberAdmission = Readonly<{
  owner: string
  projectContextId: string
  extractionSchemaId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  requestedModels: ExtractionModelChoice | null
  batchExtractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  preprocessId: string
}>

/** One pending member Extraction and its `runExtraction` workflow, in the batch's admission transaction. */
export async function admitBatchMember(
  orm: DatabaseOrm,
  client: Parameters<ExtractionExecution['enqueue']>[0],
  execution: ExtractionExecution,
  member: BatchMemberAdmission,
): Promise<void> {
  const id = batchMemberExtractionId(member.batchExtractionId, member.sourceDocumentId)
  await orm.public.Extraction.create({
    id,
    sourceDocumentId: member.sourceDocumentId,
    sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
    schemaRevisionId: member.schemaRevisionId,
    strategy: member.strategy,
    catalogRecipe: null,
    requestedModels: member.requestedModels,
    batchExtractionId: member.batchExtractionId,
  })
  await execution.enqueue(client, {
    workflowName: RUN_EXTRACTION,
    workflowID: extractWorkflowId(id),
    queueName: EXTRACTION_QUEUE,
    authenticatedUser: member.owner,
    attributes: extractionAttributes(member),
  }, id)
}
export type AdmitBatchMember = typeof admitBatchMember
