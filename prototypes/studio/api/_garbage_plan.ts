import { LIVE_WORKFLOW_STATUSES, type CanonicalPackageDescriptor, type ScopeIds, type ScopeSnapshot } from 'db'
import {
  extractionIdOfWorkflow, extractWorkflowId, GC_PREFIX, keiConvertOkSchema, keiRunOf, STUDIO_EXTRACT_PREFIX,
  type KeiDeleteRunsInput,
} from 'extraction/kei-handoff'
import { CANONICAL_UUID } from 'studio-configuration'
import type { StagedSource } from './_source_inbox.js'

// Every rule of the spec's *Deletion and garbage collection* as a pure function over the rows collectGarbage reads:
// nothing here reads, cancels or deletes.

export type GarbagePolicy = Readonly<{
  interactiveRetentionMs: number
  backgroundRetentionMs: number
  sweepRetentionMs: number
  fileMinAgeMs: number
  historyBatch: number
}>

/** A DBOS workflow status row, as the sweep reads it; times are epoch milliseconds from the database clock. */
export type WorkflowRow = Readonly<{
  workflowID: string
  status: string
  updatedAt?: number
  completedAt?: number
  attributes?: Readonly<Record<string, unknown>>
  output?: unknown
}>

const HOUR = 3_600_000
export const GC_POLICY: GarbagePolicy = {
  interactiveRetentionMs: 24 * HOUR,
  backgroundRetentionMs: 30 * 24 * HOUR,
  sweepRetentionMs: 24 * HOUR,
  fileMinAgeMs: 24 * HOUR,
  historyBatch: 1000,
}
export const TERMINAL_STATUSES = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const
export const STUDIO_WORKFLOW_PREFIXES = [STUDIO_EXTRACT_PREFIX, 'suggest:', 'ingest:', 'reprocess:', 'suggestion:', 'edit:'] as const
export const SWEEP_PREFIX = 'sched-collectGarbage-'
const INTERACTIVE_PREFIXES = ['suggestion:', 'edit:']
const KEI_CONVERT = 'kei-convert:'
const KEI_EXTRACT = 'kei-extract:'
const LIVE = LIVE_WORKFLOW_STATUSES
const TERMINAL = new Set<string>(TERMINAL_STATUSES)
const ENDED = new Set(['SUCCESS', 'ERROR'])
const STOPPED = new Set(['CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])
const SUGGEST = /^suggest:([^:]+):(\d+)$/

/** Whether a Studio workflow can run no more steps: gone, ended, or stopped (both stamped from the database clock)
 *  before this process booted. A step of a workflow cancelled in this process may still be running and checkpoint
 *  (spec, *Cancelled Studio history*); no elapsed age proves otherwise. */
export function quiescent(row: WorkflowRow | undefined, bootTimestampMs: number): boolean {
  if (!row || ENDED.has(row.status)) return true
  return STOPPED.has(row.status) && row.updatedAt !== undefined && row.updatedAt < bootTimestampMs
}

export function keiParentOf(keiWorkflowId: string): string | null {
  if (keiWorkflowId.startsWith(KEI_EXTRACT)) return extractWorkflowId(keiWorkflowId.slice(KEI_EXTRACT.length))
  if (keiWorkflowId.startsWith(KEI_CONVERT)) return keiWorkflowId.slice(KEI_CONVERT.length) || null
  return null
}

const endedAt = (row: WorkflowRow) => row.completedAt ?? row.updatedAt ?? Number.POSITIVE_INFINITY
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const owned = (workflowId: string) =>
  workflowId.startsWith(SWEEP_PREFIX) || STUDIO_WORKFLOW_PREFIXES.some((prefix) => workflowId.startsWith(prefix))

/** Only a canonical UUID can name a row. The scope read reports any other ID as absent without asking the database,
 *  so its absence proves nothing: a malformed or missing ID never condemns a workflow on scope grounds. */
const canonical = (value: unknown): value is string => typeof value === 'string' && CANONICAL_UUID.test(value)
/** A well-formed ID that is absent from the snapshot; a missing, null or malformed attribute names nothing. */
const missing = (present: ReadonlySet<string> | ReadonlyMap<string, unknown>, value: unknown) =>
  canonical(value) && !present.has(value)

function scopeGone(row: WorkflowRow, scopes: ScopeSnapshot): boolean {
  const attributes = row.attributes ?? {}
  return (
    missing(scopes.projectContexts, attributes.projectContextId) ||
    missing(scopes.sourceDocuments, attributes.sourceDocumentId) ||
    missing(scopes.sourceRepresentationRevisions, attributes.sourceRepresentationRevisionId) ||
    missing(scopes.extractionSchemas, attributes.extractionSchemaId) || // null: a first generation, no schema yet
    missing(scopes.suggestions, attributes.batchSchemaSuggestionId)
  )
}

/** The row a row-backed workflow publishes into is gone. */
function rowGone(row: WorkflowRow, scopes: ScopeSnapshot): boolean {
  const extraction = extractionIdOfWorkflow(row.workflowID)
  const suggestion = SUGGEST.exec(row.workflowID)
  if (extraction !== null) return missing(scopes.extractions, extraction)
  if (suggestion) return missing(scopes.suggestions, suggestion[1])
  return false
}

/** The domain already holds this attempt's outcome, or never will (spec, *Propagation is retried*). */
function settled(row: WorkflowRow, scopes: ScopeSnapshot): boolean {
  const extraction = extractionIdOfWorkflow(row.workflowID)
  const suggestion = SUGGEST.exec(row.workflowID)
  if (extraction !== null) return canonical(extraction) && (scopes.extractions.get(extraction)?.settled ?? true)
  if (suggestion) {
    if (!canonical(suggestion[1])) return false
    const current = scopes.suggestions.get(suggestion[1])
    return !current || current.attempt !== Number(suggestion[2]) || current.settled
  }
  return false
}

/** Every row a set of workflows names by attribute or by workflow ID, for one scope read. */
export function scopeIdsOf(rows: readonly WorkflowRow[]): ScopeIds {
  const projects = new Set<string>()
  const documents = new Set<string>()
  const revisions = new Set<string>()
  const schemas = new Set<string>()
  const suggestions = new Set<string>()
  const extractions = new Set<string>()
  const add = (set: Set<string>, value: unknown) => {
    if (typeof value === 'string') set.add(value)
  }
  for (const row of rows) {
    const attributes = row.attributes ?? {}
    add(projects, attributes.projectContextId)
    add(documents, attributes.sourceDocumentId)
    add(revisions, attributes.sourceRepresentationRevisionId)
    add(schemas, attributes.extractionSchemaId)
    add(suggestions, attributes.batchSchemaSuggestionId)
    add(extractions, extractionIdOfWorkflow(row.workflowID))
    add(suggestions, SUGGEST.exec(row.workflowID)?.[1])
  }
  const sorted = (set: Set<string>) => [...set].sort()
  return {
    projectContextIds: sorted(projects),
    sourceDocumentIds: sorted(documents),
    sourceRepresentationRevisionIds: sorted(revisions),
    extractionSchemaIds: sorted(schemas),
    batchSchemaSuggestionIds: sorted(suggestions),
    extractionIds: sorted(extractions),
  }
}

/** Live work a missed or late cancel left running (spec, *Orphaned execution*): Studio work whose scope is gone or
 *  whose domain row is settled, and kei children outliving their parent. */
export function planCancellationRepair(input: {
  liveStudio: readonly WorkflowRow[]
  liveKei: readonly WorkflowRow[]
  parents: ReadonlyMap<string, WorkflowRow>
  scopes: ScopeSnapshot
}): { studio: string[]; kei: string[] } {
  const studio = input.liveStudio
    .filter((row) => LIVE.has(row.status) && (scopeGone(row, input.scopes) || settled(row, input.scopes)))
    .map((row) => row.workflowID)
  const stopping = new Set(studio)
  const live = new Map(input.liveStudio.map((row) => [row.workflowID, row]))
  const kei = input.liveKei
    .filter((row) => {
      const parentId = LIVE.has(row.status) ? keiParentOf(row.workflowID) : null
      if (parentId === null) return false // kei-gc and anything else are kei's own
      if (stopping.has(parentId)) return true
      const parent = live.get(parentId) ?? input.parents.get(parentId)
      return !parent || !LIVE.has(parent.status) // a child outliving its parent: a missed or late cancel
    })
    .map((row) => row.workflowID)
  return { studio: studio.sort(), kei: kei.sort() }
}

/** Studio histories due for deletion, oldest first, at most one batch (spec, *History retention*). */
export function planStudioHistory(input: {
  rows: readonly WorkflowRow[]
  scopes: ScopeSnapshot
  nowMs: number
  bootTimestampMs: number
  policy: GarbagePolicy
}): string[] {
  const { policy } = input
  const due = input.rows.filter((row) => {
    if (!owned(row.workflowID) || !TERMINAL.has(row.status) || !quiescent(row, input.bootTimestampMs)) return false
    const age = input.nowMs - endedAt(row)
    if (row.workflowID.startsWith(SWEEP_PREFIX)) return age >= policy.sweepRetentionMs
    if (scopeGone(row, input.scopes) || rowGone(row, input.scopes)) return true // deleted scopes bypass age, not quiescence
    const interactive = INTERACTIVE_PREFIXES.some((prefix) => row.workflowID.startsWith(prefix))
    return age >= (interactive ? policy.interactiveRetentionMs : policy.backgroundRetentionMs)
  })
  return due
    .sort((a, b) => endedAt(a) - endedAt(b))
    .slice(0, policy.historyBatch)
    .map((row) => row.workflowID)
}

function convertedRunOf(output: unknown): string | null {
  const parsed = keiConvertOkSchema.safeParse(output)
  return parsed.success ? parsed.data.run_id : null
}

/** The conversions and kei histories to hand kei's deleteRuns, or null when nothing is due (spec, *kei runs and
 *  history*). Studio names conversions, never runs; kei rechecks its own writers and boot boundary. */
export function planKeiCleanup(input: {
  kei: readonly WorkflowRow[]
  parents: ReadonlyMap<string, WorkflowRow>
  runHolders: readonly WorkflowRow[]
  referencedPreprocessIds: ReadonlySet<string>
  extractions: ReadonlyMap<string, { settled: boolean }>
  nowMs: number
  bootTimestampMs: number
  policy: GarbagePolicy
}): KeiDeleteRunsInput | null {
  const referenced = new Set<string>()
  for (const preprocessId of input.referencedPreprocessIds) {
    const run = keiRunOf(preprocessId)?.runId
    if (run) referenced.add(run)
  }
  const protectedRuns = new Set<string>()
  // Late handoffs: a Studio extraction that may still hand its run to kei keeps it (spec, *Late handoffs*) …
  for (const holder of input.runHolders) {
    const run = text(holder.attributes?.keiRunId)
    if (run && !quiescent(holder, input.bootTimestampMs)) protectedRuns.add(run)
  }
  // … and so does a kei extraction reading it now ("cleanup rechecks the run's kei children before passing it on").
  for (const row of input.kei) {
    const run = text(row.attributes?.keiRunId)
    if (run && row.workflowID.startsWith(KEI_EXTRACT) && LIVE.has(row.status)) protectedRuns.add(run)
  }
  const conversions: string[] = []
  const history: string[] = []
  for (const row of input.kei) {
    if (!TERMINAL.has(row.status)) continue
    const age = input.nowMs - endedAt(row)
    if (row.workflowID.startsWith(GC_PREFIX)) {
      if (age >= input.policy.sweepRetentionMs) history.push(row.workflowID)
      continue
    }
    const parentId = keiParentOf(row.workflowID)
    if (parentId === null || !quiescent(input.parents.get(parentId), input.bootTimestampMs)) continue
    if (row.workflowID.startsWith(KEI_CONVERT)) {
      const run = convertedRunOf(row.output) // null: failed or stopped, a run no revision can reference
      if (run !== null && (referenced.has(run) || protectedRuns.has(run))) continue
      conversions.push(row.workflowID)
    } else {
      if (missing(input.extractions, row.workflowID.slice(KEI_EXTRACT.length)) || age >= input.policy.backgroundRetentionMs)
        history.push(row.workflowID)
    }
  }
  if (conversions.length === 0 && history.length === 0) return null
  return { conversions: conversions.sort(), history: history.sort() }
}

/** Staged uploads no attempt or kei child can still read (spec, *Staged uploads*). */
export function planStagedSources(input: {
  files: readonly StagedSource[]
  parents: ReadonlyMap<string, WorkflowRow>
  children: ReadonlyMap<string, WorkflowRow>
  nowMs: number
  policy: GarbagePolicy
}): string[] {
  return input.files
    .filter((file) => {
      if (input.nowMs - file.modifiedMs < input.policy.fileMinAgeMs) return false
      if (file.temporary) return true
      if (file.workflowId === null) return false
      const parent = input.parents.get(file.workflowId)
      if (parent && !TERMINAL.has(parent.status)) return false // an active attempt keeps its PDF
      const child = input.children.get(`${KEI_CONVERT}${file.workflowId}`)
      return !child || !LIVE.has(child.status) // kei may still be reading it
    })
    .map((file) => file.relative)
    .sort()
}

/** Old unreferenced packages and old leftovers, with the cutoff the store rechecks before deleting (spec, *Packages*). */
export function planPackages(input: {
  packages: readonly { descriptor: CanonicalPackageDescriptor; modifiedMs: number }[]
  leftovers: readonly { name: string; modifiedMs: number }[]
  referenced: ReadonlySet<string>
  nowMs: number
  policy: GarbagePolicy
}): { packages: CanonicalPackageDescriptor[]; leftovers: string[]; modifiedBeforeMs: number } {
  const modifiedBeforeMs = input.nowMs - input.policy.fileMinAgeMs
  return {
    packages: input.packages
      .filter((entry) => entry.modifiedMs < modifiedBeforeMs && !input.referenced.has(entry.descriptor.artifactReference))
      .map((entry) => entry.descriptor),
    leftovers: input.leftovers.filter((entry) => entry.modifiedMs < modifiedBeforeMs).map((entry) => entry.name),
    modifiedBeforeMs,
  }
}
