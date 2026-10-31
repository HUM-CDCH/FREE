import type {
  FieldEdit,
  SchemaAddition,
  SchemaEditResponse,
} from '../shared/schemaEdit.contract.js'
import type {
  ResearcherProjectStore,
  SchemaRevisionRecord,
  SchemaSource,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  duplicateFieldKeys,
  enumerateFieldPaths,
  schemaDefinitionToTemplate,
  templateToSchemaDefinition,
  type SchemaDefinition,
  type SchemaNode,
} from 'extraction/schema'
import type { ScalarFieldType } from 'extraction/allowed-values'
import type { ModelCaller } from './_model_execution.js'
import { generateSchemaWithModel } from './_schema_suggestion.js'
import { respondToSchemaEdit } from './_schema_chat.js'
import { withFieldDescriptions } from './_schema_edit_output.js'
import { chatHistoryText } from './_schema.js'
import { chatHistorySchema, type ChatHistory } from '../shared/schemaChat.contract.js'
import { ApiError, persistenceUnavailable } from './_http.js'

type SchemaEditOptions = {
  /** Whose configuration the model call resolves. */
  caller: ModelCaller
  temperature?: number
  /** The browser's request: when it goes away the model call, and any wait for a key, ends. */
  signal?: AbortSignal
  generate?: typeof generateSchemaWithModel
  /** A chat message may ask a question instead: answer it (`answered`) rather than propose a change. */
  answerable?: boolean
  respond?: typeof respondToSchemaEdit
  /** The chat before this message, oldest first, which the model reads with it. */
  history?: ChatHistory
}

export { parseSchemaNodes } from 'extraction/schema'

type SourceContextStore = Pick<
  ResearcherProjectStore,
  'getSourceRepresentation'
>

type SchemaRevisionStore = Pick<
  ResearcherProjectStore,
  'getSchemaRevision'
>

export function formContextIdentity(form: FormData, name: string): string {
  const value = form.get(name)
  if (typeof value !== 'string' || !canonicalUuidSchema.safeParse(value).success)
    throw new ApiError(
      422,
      'invalid_request',
      `${name} must be a canonical lowercase UUID.`,
    )
  return value
}

/** The owner check for a source revision, without reading its package: the Source Document it belongs to. The
 *  workflow reads the Markdown itself, outside history (spec, *What DBOS history holds*). */
export async function ownedSourceScope(
  store: SourceContextStore,
  projectContextId: string,
  sourceRepresentationRevisionId: string,
): Promise<{ sourceDocumentId: string }> {
  const descriptor = await store
    .getSourceRepresentation(projectContextId, sourceRepresentationRevisionId)
    .catch((cause) => {
      throw persistenceUnavailable(cause)
    })
  if (!descriptor)
    throw new ApiError(
      404,
      'not_found',
      'Project model context was not found.',
    )
  return { sourceDocumentId: descriptor.sourceDocumentId }
}

/** The form's `history`: the chat before the message, as JSON (422 when malformed); none when absent. */
export function formChatHistory(form: FormData): ChatHistory {
  const value = form.get('history')
  if (value === null) return []
  let parsed: unknown
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : null
  } catch {
    parsed = null
  }
  const history = chatHistorySchema.safeParse(parsed)
  if (!history.success) throw new ApiError(422, 'invalid_request', 'history must be a JSON list of chat messages.')
  return history.data
}

/** A generation's base, when the form names one: both fields or neither (422 otherwise). */
export function optionalSchemaBase(form: FormData): { extractionSchemaId: string; schemaRevisionId: string } | null {
  const hasSchema = form.get('extraction_schema_id') !== null
  const hasRevision = form.get('base_schema_revision_id') !== null
  if (!hasSchema && !hasRevision) return null
  if (hasSchema !== hasRevision)
    throw new ApiError(422, 'invalid_request', 'extraction_schema_id and base_schema_revision_id go together.')
  return {
    extractionSchemaId: formContextIdentity(form, 'extraction_schema_id'),
    schemaRevisionId: formContextIdentity(form, 'base_schema_revision_id'),
  }
}

export async function loadOwnedSchemaRevision(
  store: SchemaRevisionStore,
  projectContextId: string,
  extractionSchemaId: string,
  schemaRevisionId: string,
): Promise<SchemaRevisionRecord> {
  const revision = await store
    .getSchemaRevision(
      projectContextId,
      extractionSchemaId,
      schemaRevisionId,
    )
    .catch((cause) => {
      throw persistenceUnavailable(cause)
    })
  if (!revision)
    throw new ApiError(
      404,
      'not_found',
      'Project model context was not found.',
    )
  return revision
}

/**
 * A schema edit proposal through Schema Suggestion: the model receives the current schema as a template, its field
 * notes and the researcher's change request (with the source, when one is named) and returns the whole revised
 * template with scalar note changes beside it, which are compared with the current tree to give the per-field
 * proposal the researcher reviews.
 */
export async function proposeSchemaEdit(
  definition: SchemaDefinition,
  instruction: string,
  source: SchemaSource | null,
  options: SchemaEditOptions,
): Promise<SchemaEditResponse> {
  const duplicates = duplicateFieldKeys(enumerateFieldPaths(definition.schemaNodes))
  if (duplicates.length) {
    return { status: 'refused', message: `Duplicate field paths: ${duplicates.join(', ')}` }
  }

  const input = {
    document: source
      ? { file: null, pages: null, markdown: source.markdown, pageSpans: source.pageSpans }
      : { file: null, pages: null, markdown: NO_SOURCE },
    instruction: schemaRevisionInstruction(definition, instruction, options.history),
    edit: true as const,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    signal: options.signal,
  }
  let template: Record<string, unknown>
  let fieldDescriptions: unknown
  try {
    if (options.answerable) {
      const reply = await (options.respond ?? respondToSchemaEdit)(
        options.caller, input, { message: instruction, context: schemaChatContext(definition), history: options.history ?? [] })
      if ('answer' in reply) return { status: 'answered', answer: reply.answer }
      template = reply.template
      fieldDescriptions = reply.fieldDescriptions
    } else {
      const reply = await (options.generate ?? generateSchemaWithModel)(options.caller, input)
      template = reply.template
      fieldDescriptions = reply.fieldDescriptions
    }
  } catch (error) {
    if (error instanceof ApiError && isModelProposalFailure(error)) return FAILED
    throw error
  }
  let revised: SchemaDefinition
  try {
    revised = templateToSchemaDefinition(template)
    revised.schemaNodes = withFieldDescriptions(revised.schemaNodes, fieldDescriptions)
  } catch {
    return FAILED
  }
  return { status: 'proposed', ...schemaEditBetween(definition.schemaNodes, revised.schemaNodes), issues: [] }
}

/** The current schema as an edit chat's question reads it. */
export function schemaChatContext(definition: SchemaDefinition): string {
  return `The researcher's current extraction schema:\n${JSON.stringify(schemaDefinitionToTemplate(definition), null, 2)}`
}

const NO_SOURCE = 'No source document accompanies this schema edit; revise the schema from the change request alone.'
const FAILED: SchemaEditResponse = { status: 'failed', message: 'Schema edit generation failed.' }

function isModelProposalFailure(error: ApiError): boolean {
  return error.code === 'invalid_model_output' || error.code === 'model_operation_failed'
}

/** The Schema Suggestion instruction for an edit: the current template, its field notes and the change request. */
export function schemaRevisionInstruction(definition: SchemaDefinition, request: string, history: ChatHistory = []): string {
  const notes = enumerateFieldPaths(definition.schemaNodes)
    .filter(({ node }) => node.description)
    .map(({ path, node }) => `- ${path.join('.')}: ${node.description}`)
  const conversation = chatHistoryText(history)
  return `Revise the researcher's current extraction schema according to the change request, and return the complete revised schema in the same template form.

Current schema:
${JSON.stringify(schemaDefinitionToTemplate(definition), null, 2)}
${notes.length ? `\nField notes from the current schema:\n${notes.join('\n')}\n` : ''}${conversation ? `\n${conversation}\n` : ''}
Change request:
${request.trim()}

Keep every field, its name, its type and its nesting exactly as they are unless the change request asks to change them, and keep "_description" unless the change request is about what one record is. Return the whole schema, including the unchanged fields, never only the changed ones.`
}

/**
 * The proposal that turns `current` into `revised`. Fields are matched by name level by level. A field left unmatched
 * is renamed when it is its level's only unmatched pair, or when the revision has an unmatched field of the same shape
 * in its place; any other is removed, and an unmatched revised field is added (an added group's own fields follow it
 * as further additions). Unchanged fields are left out.
 */
export function schemaEditBetween(
  current: readonly SchemaNode[],
  revised: readonly SchemaNode[],
): { fields: Record<string, FieldEdit>; additions: SchemaAddition[] } {
  const fields: Record<string, FieldEdit> = {}
  const additions: SchemaAddition[] = []
  const add = (node: SchemaNode, parentPath: readonly string[]) => {
    const path = [...parentPath, node.name]
    additions.push({ path, ...nodeShape(node), ...(node.description && { description: node.description }) })
    node.children?.forEach((child) => add(child, path))
  }
  const compare = (level: readonly SchemaNode[], next: readonly SchemaNode[], parentPath: readonly string[]) => {
    const unmatched = next.filter((node) => !level.some((old) => old.name === node.name))
    const orphans = level.filter((old) => !next.some((node) => node.name === old.name))
    const renames = new Map<SchemaNode, SchemaNode>()
    if (orphans.length === 1 && unmatched.length === 1) renames.set(orphans[0]!, unmatched[0]!)
    else for (const old of orphans) {
      const node = next[level.indexOf(old)]
      if (node && unmatched.includes(node) && sameShape(old, node)) renames.set(old, node)
    }
    const renamedTo = new Set(renames.values())
    for (const old of level) {
      const node = next.find((candidate) => candidate.name === old.name) ?? renames.get(old)
      if (!node) {
        fields[old.id] = { name: old.name, removed: true, ...nodeShape(old) }
        continue
      }
      // Absent notes stay unchanged; an edit's scalar-note sidecar can also supply text or an explicit empty clear.
      const edit: FieldEdit = { name: node.name, removed: false, description: node.description ?? null, ...nodeShape(node, old) }
      if (changesField(old, edit)) fields[old.id] = edit
      if (node.children) compare(old.children ?? [], node.children, [...parentPath, node.name])
    }
    for (const node of unmatched) if (!renamedTo.has(node)) add(node, parentPath)
  }
  compare(current, revised, [])
  return { fields, additions }
}

type NodeShape =
  | { type: 'array'; itemType: ScalarFieldType | null }
  | { type: 'string'; allowedValues?: string[] }
  | { type: Exclude<SchemaNode['type'], 'array' | 'string'> }

/** A node's type as an edit or an addition gives it; a closed set the revision dropped from `old` is cleared ([]). */
function nodeShape(node: SchemaNode, old?: SchemaNode): NodeShape {
  if (node.type === 'array') return { type: 'array', itemType: node.children ? null : node.itemType }
  if (node.type === 'string') {
    const allowedValues = node.allowedValues ?? (old?.allowedValues ? [] : undefined)
    return { type: 'string', ...(allowedValues && { allowedValues }) }
  }
  return { type: node.type }
}

function sameShape(left: SchemaNode, right: SchemaNode): boolean {
  return left.type === right.type && (left.children === undefined) === (right.children === undefined) && left.itemType === right.itemType
}

function changesField(old: SchemaNode, edit: FieldEdit): boolean {
  if (edit.name !== old.name || edit.type !== old.type) return true
  if (edit.description != null && edit.description !== (old.description ?? '')) return true
  if (edit.type === 'array') return edit.itemType !== (old.children ? null : old.itemType)
  if (edit.type === 'string' && edit.allowedValues != null)
    return JSON.stringify(edit.allowedValues.length ? edit.allowedValues : undefined) !== JSON.stringify(old.allowedValues)
  return false
}
