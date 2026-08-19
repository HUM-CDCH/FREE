import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import {
  createProjectStore,
  type ProjectStore,
  type SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import {
  batchSchemaSuggestionMergeResponseSchema,
  batchSchemaSuggestionRequestSchema,
} from '../shared/batchSchemaSuggestion.contract.js'
import { parseSchemaDefinition } from '../shared/schemaNode.js'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import { generateSchemaWithModel } from './_model.js'
import {
  runSourceSchemaSuggestion,
  sourceSuggestionFailure,
  validateEditableSuggestion,
  verifiedCommonSuggestion,
} from './_batch_schema_suggestions.js'

const ROUTE = '/api/batch-schema-suggestions'

type Store = Pick<
  ProjectStore,
  | 'getBatchSchemaSuggestionInputs'
  | 'confirmBatchSchemaSuggestion'
  | 'beginSourceSchemaSuggestion'
  | 'completeSourceSchemaSuggestion'
  | 'failSourceSchemaSuggestion'
>

type Dependencies = {
  generate?: typeof generateSchemaWithModel
  readMarkdown?: typeof canonicalPackageStore.read
}

function revisionDto(revision: SchemaRevisionRecord) {
  return {
    schemaRevisionId: revision.schemaRevisionId,
    extractionSchemaId: revision.extractionSchemaId,
    revisionNumber: revision.revisionNumber,
    origin: revision.origin,
    createdAt: revision.createdAt.toISOString(),
    ...parseSchemaDefinition(revision.schemaTree),
  }
}

export function createBatchSchemaSuggestionsApi(
  store: Store = createProjectStore(),
  dependencies: Dependencies = {},
) {
  const generate = dependencies.generate ?? generateSchemaWithModel
  return async function POST(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== ROUTE)
        throw new ApiError(
          404,
          'not_found',
          'Schema suggestion route was not found.',
        )
      const parsed = batchSchemaSuggestionRequestSchema.safeParse(
        await parseJsonRequest(request),
      )
      if (!parsed.success)
        throw new ApiError(
          422,
          'invalid_request',
          'The schema suggestion request is invalid.',
        )

      if (parsed.data.action === 'confirm') {
        const definition = validateEditableSuggestion(
          parseSchemaDefinition({
            recordDescription: parsed.data.recordDescription,
            schemaNodes: parsed.data.schemaNodes,
          }),
        )
        const confirmed = await store
          .confirmBatchSchemaSuggestion(
            parsed.data.projectContextId,
            parsed.data.sourceDocumentIds,
            parsed.data.selectionKey,
            definition,
          )
          .catch((cause) => {
            throw persistenceUnavailable(cause)
          })
        if (!confirmed)
          throw new ApiError(
            422,
            'invalid_selection',
            'Use Source Documents in this Project Context.',
          )
        if (confirmed.status === 'invalid')
          throw new ApiError(
            409,
            'selection_changed',
            'The selected Source Documents changed. Suggest common fields again.',
          )
        if (confirmed.status === 'conflict')
          throw new ApiError(
            409,
            'revision_conflict',
            'The Current Schema Revision changed while these fields were being confirmed. Review and run again.',
            {
              details: {
                currentRevision: revisionDto(confirmed.currentRevision),
              },
            },
          )
        return json(
          { revision: revisionDto(confirmed.revision) },
          {
            status: confirmed.status === 'created' ? 201 : 200,
            headers: noStore,
          },
        )
      }

      const cached = await store
        .getBatchSchemaSuggestionInputs(
          parsed.data.projectContextId,
          parsed.data.sourceDocumentIds,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!cached)
        throw new ApiError(
          422,
          'invalid_selection',
          'Use Source Documents in this Project Context.',
        )
      const failed = new Map<
        string,
        ReturnType<typeof sourceSuggestionFailure>['code']
      >()
      for (const sourceDocumentId of parsed.data.sourceDocumentIds) {
        try {
          await runSourceSchemaSuggestion(
            store,
            parsed.data.projectContextId,
            sourceDocumentId,
            {
              generate,
              ...(dependencies.readMarkdown
                ? { readMarkdown: dependencies.readMarkdown }
                : {}),
            },
          )
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.code === 'persistence_unavailable'
          )
            throw error
          failed.set(sourceDocumentId, sourceSuggestionFailure(error).code)
        }
      }
      const prepared = await store
        .getBatchSchemaSuggestionInputs(
          parsed.data.projectContextId,
          parsed.data.sourceDocumentIds,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!prepared || prepared.selectionKey !== cached.selectionKey)
        throw new ApiError(
          409,
          'selection_changed',
          'The selected Source Documents changed. Suggest common fields again.',
        )
      const unresolved = prepared.suggestions
        .filter((suggestion) => suggestion.template === null)
        .map((suggestion) => suggestion.sourceDocumentId)
      const unresolvedFailures = unresolved.flatMap((sourceDocumentId) => {
        const code = failed.get(sourceDocumentId)
        return code === undefined ? [] : [{ sourceDocumentId, code }]
      })
      if (unresolvedFailures.length > 0)
        throw new ApiError(
          502,
          'source_suggestion_failed',
          'Fields could not be suggested for every selected Source Document. Try again.',
          { details: { failures: unresolvedFailures } },
        )
      if (unresolved.length > 0)
        throw new ApiError(
          409,
          'suggestions_pending',
          'Field suggestions are still being prepared. Try again shortly.',
          { details: { sourceDocumentIds: unresolved } },
        )
      const merged = await generate({
        document: {
          file: null,
          markdown: prepared.suggestions
            .map(
              (suggestion) =>
                `SOURCE DOCUMENT ${suggestion.sourceDocumentId} SUGGESTION:\n${JSON.stringify(suggestion.template)}`,
            )
            .join('\n\n'),
          pages: null,
        },
        instruction:
          'Return one compact Extraction Schema containing only fields present in every supplied Source Document suggestion. Do not include extracted values, alternatives, merge notes, or canonical Evidence fields (_evidence, snippets, pages, bboxes, occurrence IDs, fuzzy matches).',
      })
      const current = await store
        .getBatchSchemaSuggestionInputs(
          parsed.data.projectContextId,
          parsed.data.sourceDocumentIds,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!current || current.selectionKey !== cached.selectionKey)
        throw new ApiError(
          409,
          'selection_changed',
          'The selected Source Documents changed. Suggest common fields again.',
        )
      const common = verifiedCommonSuggestion(
        merged.template,
        current.suggestions.map((suggestion) => suggestion.template),
      )
      return json(
        batchSchemaSuggestionMergeResponseSchema.parse(
          common
            ? {
                status: 'ready',
                selectionKey: cached.selectionKey,
                ...common.definition,
                coverage: common.coverage,
              }
            : { status: 'heterogeneous', selectionKey: cached.selectionKey },
        ),
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export const POST = createBatchSchemaSuggestionsApi()
