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
  modelSuggestedDefinition,
  sourceSuggestionFailure,
  validateEditableSuggestion,
  verifiedCommonSuggestion,
} from './_batch_schema_suggestions.js'

const ROUTE = '/api/batch-schema-suggestions'
const SCHEMA_SUGGESTION_TIMEOUT_MS = 10 * 60 * 1000
const SOURCE_SUGGESTION_INSTRUCTION =
  'Suggest reusable extraction fields for this Source Document. Never include canonical Evidence fields: _evidence, snippets, pages, bboxes, occurrence IDs, or fuzzy matches.'

type Store = Pick<
  ProjectStore,
  | 'getBatchSchemaSuggestionSources'
  | 'confirmBatchSchemaSuggestion'
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
            'The Current Schema Revision changed while these fields were being confirmed. Suggest common fields again.',
          )
        return json(
          { revision: revisionDto(confirmed.revision) },
          {
            status: confirmed.status === 'created' ? 201 : 200,
            headers: noStore,
          },
        )
      }

      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(SCHEMA_SUGGESTION_TIMEOUT_MS),
      ])
      const selected = await store
        .getBatchSchemaSuggestionSources(
          parsed.data.projectContextId,
          parsed.data.sourceDocumentIds,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!selected)
        throw new ApiError(
          422,
          'invalid_selection',
          'Use Source Documents in this Project Context.',
        )
      const suggested = [] as Array<{
        sourceDocumentId: string
        template: unknown
      }>
      const failures = [] as Array<{
        sourceDocumentId: string
        code: ReturnType<typeof sourceSuggestionFailure>['code']
      }>
      for (const source of selected.sources) {
        signal.throwIfAborted()
        try {
          const artifact = await (
            dependencies.readMarkdown ?? canonicalPackageStore.read
          )(source.descriptor, 'markdown')
          signal.throwIfAborted()
          const generated = await generate({
            document: {
              file: null,
              markdown: new TextDecoder().decode(artifact.bytes),
              pages: null,
            },
            instruction: SOURCE_SUGGESTION_INSTRUCTION,
            signal,
          })
          suggested.push({
            sourceDocumentId: source.sourceDocumentId,
            template: modelSuggestedDefinition(generated.template),
          })
        } catch (error) {
          if (signal.aborted) throw error
          failures.push({
            sourceDocumentId: source.sourceDocumentId,
            code: sourceSuggestionFailure(error).code,
          })
        }
      }
      if (failures.length > 0)
        throw new ApiError(
          502,
          'source_suggestion_failed',
          'Fields could not be suggested for every selected Source Document. Try again.',
          { details: { failures } },
        )
      signal.throwIfAborted()
      const merged = await generate({
        document: {
          file: null,
          markdown: suggested
            .map(
              (suggestion) =>
                `SOURCE DOCUMENT ${suggestion.sourceDocumentId} SUGGESTION:\n${JSON.stringify(suggestion.template)}`,
            )
            .join('\n\n'),
          pages: null,
        },
        instruction:
          'Return one compact Extraction Schema containing only fields present in every supplied Source Document suggestion. Do not include extracted values, alternatives, merge notes, or canonical Evidence fields (_evidence, snippets, pages, bboxes, occurrence IDs, fuzzy matches).',
        signal,
      })
      signal.throwIfAborted()
      const current = await store
        .getBatchSchemaSuggestionSources(
          parsed.data.projectContextId,
          parsed.data.sourceDocumentIds,
        )
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!current || current.selectionKey !== selected.selectionKey)
        throw new ApiError(
          409,
          'selection_changed',
          'The selected Source Documents changed. Suggest common fields again.',
        )
      const common = verifiedCommonSuggestion(
        merged.template,
        suggested.map((suggestion) => suggestion.template),
      )
      return json(
        batchSchemaSuggestionMergeResponseSchema.parse(
          common
            ? {
                status: 'ready',
                selectionKey: selected.selectionKey,
                ...common.definition,
                coverage: common.coverage,
              }
            : { status: 'heterogeneous', selectionKey: selected.selectionKey },
        ),
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export const POST = createBatchSchemaSuggestionsApi()
