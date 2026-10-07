import { DBOS, type DBOSClient, type WorkflowStatus, type WorkflowStatusString } from '@dbos-inc/dbos-sdk'
import {
  canonicalPackageStore, createGarbageReferences, LIVE_WORKFLOW_STATUSES,
  type CanonicalPackageStore, type GarbageReferences,
} from 'db'
import {
  createKeiHandoff, keiConvertWorkflowId, keiGcWorkflowId, type KeiDeleteRunsInput, type KeiHandoff,
} from 'extraction/kei-handoff'
import { dbosSteps, isWorkflowCancellation, type WorkflowSteps } from 'extraction/workflow-steps'
import { databaseClockMs, studioDbos } from '../server/dbos.js'
import {
  GC_POLICY, STUDIO_WORKFLOW_PREFIXES, STUDIO_MAINTENANCE_PREFIXES, TERMINAL_STATUSES, keiParentOf,
  planCancellationRepair, planKeiCleanup, planPackages, planStagedSources, planStudioHistory,
  scopeIdsOf, type GarbagePolicy, type WorkflowRow,
} from './_garbage_plan.js'
import { listStagedSources, removeStagedSource, sourceInboxRoot, type StagedSource } from './_source_inbox.js'

export const COLLECT_GARBAGE = 'collectGarbage'
const NO_DATA = { loadInput: false, loadOutput: false } as const
const LIVE_STATUSES = [...LIVE_WORKFLOW_STATUSES] as WorkflowStatusString[]

export type GarbagePorts = Readonly<{
  steps: WorkflowSteps
  bootTimestampMs(): number
  clock(): Promise<number>
  studio: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow' | 'deleteWorkflows'>
  kei: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow'>
  keiHandoff: Pick<KeiHandoff, 'requestDeleteRuns'>
  references: GarbageReferences
  packages: Pick<CanonicalPackageStore, 'list' | 'leftovers' | 'remove' | 'removeLeftover'>
  inbox: Readonly<{
    root: string
    list(root: string): Promise<readonly StagedSource[]>
    remove(root: string, relative: string): Promise<void>
  }>
  policy: GarbagePolicy
  log(line: string): void
}>

export type GarbageSummary = Readonly<{
  cancelledStudio: string[]
  cancelledKei: string[]
  deletedStudioHistory: number
  keiRequest: Readonly<{ workflowId: string; conversions: string[]; history: string[] }> | null
  removedStagedSources: number
  removedPackages: number
  removedLeftovers: number
  failedPhases: string[]
}>

const rows = (statuses: readonly WorkflowStatus[]): WorkflowRow[] =>
  statuses.map(({ workflowID, status, updatedAt, completedAt, attributes, output }) =>
    ({ workflowID, status, updatedAt, completedAt, attributes, output }))
const byId = (list: readonly WorkflowRow[]) => new Map(list.map((row) => [row.workflowID, row]))
const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
const listed = async (client: Pick<DBOSClient, 'listWorkflows'>, workflowIDs: string[]) =>
  workflowIDs.length === 0 ? [] : rows(await client.listWorkflows({ workflowIDs, ...NO_DATA }))

/** Rechecking avoids moving a cancelled workflow's updatedAt into this boot, which would delay its cleanup. */
async function cancelIfLive(client: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow'>, id: string): Promise<boolean> {
  const [row] = await listed(client, [id])
  if (!row || !LIVE_WORKFLOW_STATUSES.has(row.status)) return false
  await client.cancelWorkflow(id)
  return true
}

export async function repairCancellations(ports: GarbagePorts): Promise<{ studio: string[]; kei: string[] }> {
  // Complete the phase's status and reference reads before the first cancellation.
  const liveStudio = rows(await ports.studio.listWorkflows({
    workflow_id_prefix: [...STUDIO_WORKFLOW_PREFIXES], status: [...LIVE_STATUSES], ...NO_DATA,
  }))
  const liveKei = rows(await ports.kei.listWorkflows({
    workflowName: ['convert'], status: [...LIVE_STATUSES], ...NO_DATA,
  }))
  const parents = byId(await listed(ports.studio, unique(liveKei.map((row) => keiParentOf(row.workflowID)))))
  const scopes = await ports.references.scopes(scopeIdsOf(liveStudio))
  const plan = planCancellationRepair({ liveStudio, liveKei, parents, scopes })
  const studio: string[] = []
  const kei: string[] = []
  for (const id of plan.studio) if (await cancelIfLive(ports.studio, id)) studio.push(id)
  for (const id of plan.kei) if (await cancelIfLive(ports.kei, id)) kei.push(id)
  return { studio, kei }
}

export async function collectStudioHistory(ports: GarbagePorts, nowMs: number): Promise<number> {
  const terminal = rows(await ports.studio.listWorkflows({
    workflow_id_prefix: [...STUDIO_WORKFLOW_PREFIXES, ...STUDIO_MAINTENANCE_PREFIXES],
    status: [...TERMINAL_STATUSES], ...NO_DATA,
  }))
  const scopes = await ports.references.scopes(scopeIdsOf(terminal))
  const due = planStudioHistory({
    rows: terminal, scopes, nowMs, bootTimestampMs: ports.bootTimestampMs(), policy: ports.policy,
  })
  for (let start = 0; start < due.length; start += 100)
    await ports.studio.deleteWorkflows(due.slice(start, start + 100))
  return due.length
}

export async function collectKei(ports: GarbagePorts, nowMs: number, workflowId: string): Promise<KeiDeleteRunsInput | null> {
  const kei = rows(await ports.kei.listWorkflows({
    workflowName: ['convert', 'deleteRuns', 'deleteDurableHistoryV1'], loadInput: false, loadOutput: true,
  }))
  // The parent must be quiescent before its reference read; that read then sees any final publication.
  const parents = byId(await listed(ports.studio, unique(kei.map((row) => keiParentOf(row.workflowID)))))
  const referencedPreprocessIds = await ports.references.referencedPreprocessIds()
  const request = planKeiCleanup({
    kei, parents, referencedPreprocessIds, nowMs, bootTimestampMs: ports.bootTimestampMs(), policy: ports.policy,
  })
  if (request) await ports.keiHandoff.requestDeleteRuns(workflowId, request)
  return request
}

export async function collectStagedSources(ports: GarbagePorts, nowMs: number): Promise<number> {
  const files = await ports.inbox.list(ports.inbox.root)
  const workflowIds = unique(files.map((file) => file.workflowId))
  const parents = byId(await listed(ports.studio, workflowIds))
  const children = byId(await listed(ports.kei, workflowIds.map(keiConvertWorkflowId)))
  const doomed = planStagedSources({ files, parents, children, nowMs, policy: ports.policy })
  for (const relative of doomed) await ports.inbox.remove(ports.inbox.root, relative)
  return doomed.length
}

export async function collectPackages(ports: GarbagePorts, nowMs: number): Promise<{ packages: number; leftovers: number }> {
  const [packages, leftovers] = await Promise.all([ports.packages.list(), ports.packages.leftovers()])
  const referenced = await ports.references.referencedPackages(packages.map((entry) => entry.descriptor.artifactReference))
  const plan = planPackages({ packages, leftovers, referenced, nowMs, policy: ports.policy })
  let removed = 0
  for (const descriptor of plan.packages) {
    const gone = await ports.packages.remove(descriptor,
      () => ports.references.packageIsReferenced(descriptor.artifactReference),
      { modifiedBeforeMs: plan.modifiedBeforeMs })
    if (gone) removed += 1
  }
  for (const name of plan.leftovers) await ports.packages.removeLeftover(name)
  return { packages: removed, leftovers: plan.leftovers.length }
}

export async function collectGarbageWorkflow(scheduledTime: Date, ports: GarbagePorts): Promise<GarbageSummary> {
  const nowMs = await ports.steps.step('clock', () => ports.clock())
  const failedPhases: string[] = []
  async function phase<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await ports.steps.step(name, run, { retriesAllowed: false })
    } catch (error) {
      if (isWorkflowCancellation(error)) throw error
      failedPhases.push(name)
      ports.log(`collectGarbage: ${name} failed (${error instanceof Error ? error.name : 'unknown error'}); the next sweep retries it`)
      return fallback
    }
  }
  const repaired = await phase('repairCancellations', () => repairCancellations(ports), { studio: [], kei: [] })
  const deletedStudioHistory = await phase('studioHistory', () => collectStudioHistory(ports, nowMs), 0)
  const keiWorkflowId = keiGcWorkflowId(scheduledTime)
  const request = await phase('keiRunsAndHistory', () => collectKei(ports, nowMs, keiWorkflowId), null)
  const removedStagedSources = await phase('stagedSources', () => collectStagedSources(ports, nowMs), 0)
  const packages = await phase('packages', () => collectPackages(ports, nowMs), { packages: 0, leftovers: 0 })
  return {
    cancelledStudio: repaired.studio, cancelledKei: repaired.kei, deletedStudioHistory,
    keiRequest: request && { workflowId: keiWorkflowId, conversions: request.conversions, history: request.history },
    removedStagedSources, removedPackages: packages.packages, removedLeftovers: packages.leftovers, failedPhases,
  }
}

export function registerGarbageWorkflow(ports: () => GarbagePorts) {
  return DBOS.registerWorkflow(
    (scheduledTime: Date) => collectGarbageWorkflow(new Date(scheduledTime), ports()),
    { name: COLLECT_GARBAGE },
  )
}

export function garbagePorts(overrides: Partial<GarbagePorts> = {}): GarbagePorts {
  const launched = studioDbos()
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required for garbage collection.')
  return {
    steps: dbosSteps,
    bootTimestampMs: () => launched.bootTimestampMs,
    clock: () => databaseClockMs(databaseUrl),
    studio: launched.admission,
    kei: launched.kei,
    keiHandoff: createKeiHandoff(launched.kei),
    references: createGarbageReferences(),
    packages: canonicalPackageStore,
    inbox: { root: sourceInboxRoot(), list: listStagedSources, remove: removeStagedSource },
    policy: GC_POLICY,
    log: (line) => console.warn(line),
    ...overrides,
  }
}
