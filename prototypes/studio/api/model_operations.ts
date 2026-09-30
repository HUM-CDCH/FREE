import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { executionOf, INTERRUPTED_FAILURE, LIVE_WORKFLOW_STATUSES } from 'db'
import { z } from 'zod'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { studioDbos } from '../server/dbos.js'
import { MODEL_OPERATION_WORKFLOW_ID, type ModelOperation } from '../shared/modelOperation.contract.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { ApiError, json, noStore, noStoreError, persistenceUnavailable } from './_http.js'
import type { ModelOperationClient, OperationResult } from './_model_operation.js'
import type { SchemaEditInput, SchemaEditProposed } from './_schema_edit_workflow.js'
import type { SchemaGenerated, SchemaGenerationInput } from './_schema_generation_workflow.js'

type ModelOperationStore = Pick<ResearcherProjectStore, 'researcherAccountId' | 'modelOperationScopeExists'>
const scopeSchema = z.object({ projectContextId: canonicalUuidSchema, extractionSchemaId: canonicalUuidSchema.nullable() }).strict()
const PREFIX = '/api/model-operations'
const notFound = () => new ApiError(404, 'not_found', 'Model operation was not found.')

type Admitted = Pick<WorkflowStatus, 'createdAt' | 'workflowID'>
/** Admission order with a total tie-break: DBOS stamps created_at in milliseconds and orders by it alone, so two
 *  proposals admitted in the same millisecond need one answer to "older", the same for the listing and for Discard. */
function olderThan(a: Admitted, b: Admitted): boolean {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.workflowID < b.workflowID)
}
const newestFirst = (a: Admitted, b: Admitted): number => (olderThan(a, b) ? 1 : olderThan(b, a) ? -1 : 0)

/** One workflow as the page sees it. The recorded input names the instruction and base; the output is the outcome. */
export function modelOperationOf(status: WorkflowStatus): ModelOperation | null {
  const match = MODEL_OPERATION_WORKFLOW_ID.exec(status.workflowID)
  const input = status.input?.[0] as (SchemaGenerationInput | SchemaEditInput) | undefined
  if (!match || !input) return null
  const execution = executionOf(status.status)
  const output = status.status === 'SUCCESS' ? status.output as OperationResult<SchemaGenerated | SchemaEditProposed> : null
  const settled: ModelOperation['status'] = execution === 'QUEUED' || execution === 'RUNNING' ? execution : output?.ok ? 'SUCCEEDED' : 'FAILED'
  const failure = settled !== 'FAILED' ? null : output && !output.ok ? { code: output.code, message: output.message } : { ...INTERRUPTED_FAILURE }
  const common = {
    workflowId: status.workflowID,
    operationId: match[2]!,
    status: settled,
    instruction: input.instruction,
    createdAt: new Date(status.createdAt).toISOString(),
    failure,
  }
  return match[1] === 'suggestion'
    ? { kind: 'generation', ...common, baseSchemaRevisionId: input.baseSchemaRevisionId,
        template: output?.ok ? (output as SchemaGenerated).template : null,
        sourceCoverage: output?.ok ? ((output as SchemaGenerated).sourceCoverage ?? null) : null }
    : { kind: 'proposal', ...common, baseSchemaRevisionId: (input as SchemaEditInput).baseSchemaRevisionId,
        response: output?.ok ? (output as SchemaEditProposed).response : null }
}

/** The workflow ID under `PREFIX/`, decoded, or null: no ID, a nested path or a broken escape is not an operation. */
function decodedTail(pathname: string): string | null {
  if (!pathname.startsWith(`${PREFIX}/`)) return null
  try {
    const tail = decodeURIComponent(pathname.slice(PREFIX.length + 1))
    return tail === '' ? null : tail
  } catch {
    return null
  }
}

export function createModelOperationHandlers(
  store: ModelOperationStore,
  operations: () => ModelOperationClient = () => studioDbos().admission,
) {
  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Model operations are unavailable.')
  /** Only PostgreSQL authorizes (spec, *Status and ownership*): the account owns the project, and the schema, when
   *  named, still exists in it. A deleted scope is gone at once, before garbage collection removes its workflows. */
  const inScope = (projectContextId: string, extractionSchemaId: string | null) =>
    store.modelOperationScopeExists(projectContextId, extractionSchemaId).catch((cause) => { throw unavailable(cause) })
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        if (url.pathname !== PREFIX) throw notFound()
        const scope = scopeSchema.safeParse({
          projectContextId: url.searchParams.get('projectContextId'),
          extractionSchemaId: url.searchParams.get('extractionSchemaId'),
        })
        if (!scope.success)
          throw new ApiError(422, 'invalid_request', 'projectContextId (and extractionSchemaId, when named) must be canonical lowercase UUIDs.')
        if (!(await inScope(scope.data.projectContextId, scope.data.extractionSchemaId))) throw notFound()
        const statuses = await operations().listWorkflows({
          workflow_id_prefix: ['suggestion:', 'edit:'],
          // An explicit null matches only a first generation's recorded null (JSONB containment).
          attributes: { projectContextId: scope.data.projectContextId, extractionSchemaId: scope.data.extractionSchemaId },
          authenticatedUser: store.researcherAccountId,
          loadInput: true,
          loadOutput: true,
          sortDesc: true,
          limit: 20,
        }).catch((cause) => { throw unavailable(cause) })
        return json({ operations: statuses.slice().sort(newestFirst).flatMap((status) => modelOperationOf(status) ?? []) }, { headers: noStore })
      } catch (error) {
        return noStoreError(error)
      }
    },
    async DELETE(request: Request): Promise<Response> {
      try {
        const workflowId = decodedTail(new URL(request.url).pathname)
        const match = workflowId === null ? null : MODEL_OPERATION_WORKFLOW_ID.exec(workflowId)
        if (!match || workflowId === null) throw notFound()
        const client = operations()
        const recorded = await client.getWorkflow(workflowId).catch((cause) => { throw unavailable(cause) })
        const projectContextId = recorded?.attributes?.projectContextId
        const extractionSchemaId = (recorded?.attributes?.extractionSchemaId ?? null) as string | null
        if (!recorded || recorded.authenticatedUser !== store.researcherAccountId || typeof projectContextId !== 'string'
          || !(await inScope(projectContextId, extractionSchemaId))) throw notFound()
        if (LIVE_WORKFLOW_STATUSES.has(recorded.status)) {
          await client.cancelWorkflow(workflowId).catch((cause) => { throw unavailable(cause) })
        } else if (match[1] === 'edit' && recorded.status === 'SUCCESS' && (recorded.output as OperationResult<SchemaEditProposed> | undefined)?.ok) {
          // Discard persists: this proposal and every older finished one on its base go, so an older one cannot reappear
          // and a newer one from another tab survives. Finished history is settled, so deleting it is safe at once.
          const base = (recorded.input?.[0] as SchemaEditInput).baseSchemaRevisionId
          const finished = await client.listWorkflows({
            workflow_id_prefix: 'edit:',
            attributes: { projectContextId, extractionSchemaId },
            authenticatedUser: store.researcherAccountId,
            status: 'SUCCESS',
            loadInput: true,
            loadOutput: false,
          }).catch((cause) => { throw unavailable(cause) })
          const discarded = finished
            .filter((status) => (status.input?.[0] as SchemaEditInput | undefined)?.baseSchemaRevisionId === base
              && (status.workflowID === workflowId || olderThan(status, recorded)))
            .map((status) => status.workflowID)
          await client.deleteWorkflows(discarded).catch((cause) => { throw unavailable(cause) })
        }
        return new Response(null, { status: 204, headers: noStore })
      } catch (error) {
        return noStoreError(error)
      }
    },
  }
}

export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  return createModelOperationHandlers(store)
}
