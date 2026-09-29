import { z } from 'zod'
import {
  fieldEditSchema,
  schemaAdditionSchema,
  type FieldEdit,
  type SchemaAddition,
  type SchemaEditIssue,
  type SchemaEditResponse,
} from '../shared/schemaEdit.contract.js'
import type {
  ResearcherProjectStore,
  SchemaRevisionRecord,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  duplicateFieldKeys,
  enumerateFieldPaths,
  type SchemaNode,
} from 'extraction/schema'
import {
  FIELD_TYPES,
  SCALAR_FIELD_TYPES,
  type ScalarFieldType,
} from 'extraction/allowed-values'
import { parseUnknownJson } from './_model_output.js'
import { executeEditPrompt, type ModelCaller, type ModelDependencies } from './_model_execution.js'
import type { ExecutionTarget } from './_provider.js'
import { ApiError, persistenceUnavailable } from './_http.js'

const modelEnvelopeSchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  additions: z.unknown(),
}).passthrough()

export { parseSchemaNodes } from 'extraction/schema'

type Generate = (
  prompt: string,
  temperature?: number,
  target?: ExecutionTarget,
) => Promise<string>

type SchemaEditOptions = {
  /** Whose configuration the default model call resolves. */
  caller: ModelCaller
  temperature?: number
  /** The browser's request: when it goes away the model call, and any wait for a key, ends. */
  signal?: AbortSignal
  target?: ExecutionTarget
  generate?: Generate
}

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

export async function proposeSchemaEdit(
  nodes: readonly SchemaNode[],
  instruction: string,
  documentMarkdown: string | null,
  options: SchemaEditOptions,
): Promise<SchemaEditResponse> {
  const fields = enumerateFieldPaths(nodes)
  const duplicates = duplicateFieldKeys(fields)
  if (duplicates.length) {
    return { status: 'refused', message: `Duplicate field paths: ${duplicates.join(', ')}` }
  }

  const expected = new Map(fields.map((field) => [field.id, field]))
  const generate = options.generate ?? (async (prompt, temperature, target) =>
    (await generateSchemaEditJson(options.caller, prompt, temperature, options.signal, target)).text)

  try {
    const initial = await readEnvelope(await generate(
      schemaEditPrompt(fields.map(({ id, node }) => toPromptField(id, node)), instruction, documentMarkdown),
      options.temperature,
      options.target,
    ))
    const unknownIssues = unknownFieldIssues(initial.fields, expected)
    const additions = validatedAdditions(initial.additions, unknownIssues)
    const accepted = new Map<string, FieldEdit>()
    let unresolved = validateExpected(initial.fields, expected, accepted)

    if (unresolved.size) {
      try {
        const retryIds = [...unresolved.keys()]
        const retryExpected = new Map(retryIds.map((id) => [id, expected.get(id)!]))
        const retry = await readEnvelope(await generate(
          retryPrompt(retryIds.map((id) => toPromptField(id, expected.get(id)!.node)), instruction),
          options.temperature,
          options.target,
        ))
        unknownIssues.push(...unknownFieldIssues(retry.fields, retryExpected))
        unresolved = validateExpected(retry.fields, retryExpected, accepted)
      } catch (error) {
        if (error instanceof ApiError && !isModelProposalFailure(error)) throw error
        // The validated first-pass subset remains a useful partial proposal.
      }
    }

    const issues: SchemaEditIssue[] = [
      ...unknownIssues,
      ...[...unresolved].map(([id, kind]) => ({ kind, key: expected.get(id)!.key })),
    ]
    if (expected.size > 0 && accepted.size === 0 && additions.length === 0) {
      return { status: 'failed', message: 'The model returned no usable schema proposal entries.' }
    }
    return { status: 'proposed', fields: Object.fromEntries(accepted), additions, issues }
  } catch (error) {
    if (error instanceof ApiError && !isModelProposalFailure(error)) throw error
    return { status: 'failed', message: 'Schema edit generation failed.' }
  }
}

function isModelProposalFailure(error: ApiError): boolean {
  return error.code === 'invalid_model_output' || error.code === 'model_operation_failed'
}

async function readEnvelope(text: string): Promise<z.infer<typeof modelEnvelopeSchema>> {
  const parsed = await parseUnknownJson(text, 'Edit schema model returned invalid JSON.')
  return modelEnvelopeSchema.parse(parsed)
}

function validateExpected(
  raw: Record<string, unknown>,
  expected: ReadonlyMap<string, unknown>,
  accepted: Map<string, FieldEdit>,
): Map<string, 'missing' | 'invalid'> {
  const unresolved = new Map<string, 'missing' | 'invalid'>()
  for (const key of expected.keys()) {
    const parsed = fieldEditSchema.safeParse(raw[key])
    if (parsed.success) accepted.set(key, parsed.data)
    else unresolved.set(key, Object.hasOwn(raw, key) ? 'invalid' : 'missing')
  }
  return unresolved
}

function unknownFieldIssues(raw: Record<string, unknown>, expected: ReadonlyMap<string, unknown>): SchemaEditIssue[] {
  return Object.keys(raw)
    .filter((key) => !expected.has(key))
    .map((key) => ({ kind: 'unknown-key', key }))
}

function validatedAdditions(raw: unknown, issues: SchemaEditIssue[]): SchemaAddition[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    issues.push({ kind: 'invalid', key: 'additions' })
    return []
  }
  const additions: SchemaAddition[] = []
  raw.forEach((item, index) => {
    const parsed = schemaAdditionSchema.safeParse(item)
    if (parsed.success) additions.push(parsed.data)
    else issues.push({ kind: 'invalid', key: `additions[${index}]` })
  })
  return additions
}

type PromptField =
  | { id: string; name: string; type: Exclude<SchemaNode['type'], 'array'>; description?: string; allowedValues?: string[] }
  | { id: string; name: string; type: 'array'; itemType: ScalarFieldType | null; description?: string }

type PromptFieldValue =
  | { name: string; type: Exclude<SchemaNode['type'], 'array'>; description?: string; allowedValues?: string[] }
  | { name: string; type: 'array'; itemType: ScalarFieldType | null; description?: string }

function toPromptField(id: string, node: SchemaNode): PromptField {
  const description = node.description
  if (node.type !== 'array') {
    const allowedValues = node.type === 'string' ? node.allowedValues : undefined
    return {
      id,
      name: node.name,
      type: node.type,
      ...(description && { description }),
      ...(allowedValues && { allowedValues }),
    }
  }
  return {
    id,
    name: node.name,
    type: node.type,
    itemType: node.children === undefined ? node.itemType : null,
    ...(description && { description }),
  }
}

function promptFieldValue(field: PromptField): PromptFieldValue {
  return field.type === 'array'
    ? { name: field.name, type: field.type, itemType: field.itemType, ...(field.description && { description: field.description }) }
    : {
        name: field.name,
        type: field.type,
        ...(field.description && { description: field.description }),
        ...(field.allowedValues && { allowedValues: field.allowedValues }),
      }
}

function schemaEditPrompt(fields: readonly PromptField[], instruction: string, markdown: string | null): string {
  const source = markdown === null ? '' : `\n\nSOURCE DOCUMENT MARKDOWN:\n${markdown}\nEND SOURCE DOCUMENT MARKDOWN`
  return `Edit the extraction schema according to the researcher instruction.

Researcher instruction: ${JSON.stringify(instruction)}
Existing fields, keyed by opaque field ids that must be echoed exactly and never rewritten, even when the field's own "name" is being changed:
${JSON.stringify(Object.fromEntries(fields.map((field) => [field.id, promptFieldValue(field)])), null, 2)}${source}

Return one JSON object:
{"fields":{"opaque-field-id":{"name":"field_name","type":"${FIELD_TYPES.join('|')}","removed":false,"description":"optional researcher note","allowedValues":["optional","closed","set"]}},"additions":[{"path":["existing_parent","new_scalar"],"type":"string"},{"path":["existing_parent","new_dates"],"type":"array","itemType":"date"}]}

Rules:
- fields must contain every supplied opaque field id exactly once, including unchanged and removed fields; the id itself is never renamed, only the "name" value inside it
- additions must always be present; use [] when no fields are added
- apply the researcher instruction to every relevant field; preserve only properties unrelated to that instruction
- a field's "description", where present, is a researcher note recorded directly on that field (added via the schema editor's per-field description button); treat it as additional guidance alongside the researcher instruction when deciding that field's name, type, and allowed values
- "description" is optional on every field entry and addition; set it to change or add the note (an empty string clears it), and either omit it or set it to null to leave the field's current note untouched
- "allowedValues" is optional and meaningful only when type is "string"; use it to pin a field to a fixed list of options (for example when the researcher instruction or the field's own description asks for a closed set of choices) — 2 or more values sets that closed set, an empty array clears an existing one back to free text, and either omitting it or setting it to null leaves the field's current allowed values untouched; additions may set it the same way
- itemType is allowed only when type is array; every array field and array addition requires itemType: a scalar type (${SCALAR_FIELD_TYPES.join('|')}) for a repeating scalar, or null for repeating records
- removed is true only for a removed existing field
- additions use full structural paths in the post-edit namespace (i.e. using each field's current "name", including any rename applied in this same edit) and must not invent root path segments that are not existing or explicitly added fields
- return JSON only`
}

function retryPrompt(fields: readonly PromptField[], instruction: string): string {
  return `Repair only the missing or invalid field entries for this schema edit.
Researcher instruction: ${JSON.stringify(instruction)}
Required opaque field ids and current values:
${JSON.stringify(Object.fromEntries(fields.map((field) => [field.id, promptFieldValue(field)])), null, 2)}
Return {"fields":{...},"additions":[]} with every listed field id exactly once, unchanged. Use name, type (${FIELD_TYPES.join('|')}), removed, itemType for arrays (scalar type or null for records), and optionally description and, for string fields, allowedValues (2+ values, or [] to clear). JSON only.`
}

/** Edit proposals use the Interaction Route; their envelope is interpreted by proposeSchemaEdit. */
export async function generateSchemaEditJson(
  caller: ModelCaller,
  prompt: string,
  temperature?: number,
  signal?: AbortSignal,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{ text: string }> {
  const result = await executeEditPrompt(caller, prompt, temperature, signal, target, dependencies)
  if (result.finishReason === 'length') {
    throw new ApiError(502, 'invalid_model_output', 'Schema edit model output was truncated.')
  }
  return { text: result.text.replace(/```(?:json)?|```/g, '').trim() }
}
