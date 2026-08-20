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
  CanonicalPackageDescriptor,
  CanonicalPackageStore,
} from '../../../packages/db/src/artifact-store.js'
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
import { generateSchemaEditJson } from './_model.js'
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
  temperature?: number
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

type SchemaContextStore = Pick<
  ResearcherProjectStore,
  'getSourceRepresentation' | 'getSchemaRevision'
>

type CanonicalMarkdownReader = Pick<CanonicalPackageStore, 'read'>

const markdownDecoder = new TextDecoder('utf-8', { fatal: true })

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

async function readCanonicalMarkdown(
  reader: CanonicalMarkdownReader,
  descriptor: CanonicalPackageDescriptor,
): Promise<string> {
  try {
    return markdownDecoder.decode((await reader.read(descriptor, 'markdown')).bytes)
  } catch (cause) {
    throw persistenceUnavailable(
      cause,
      'Source Document artifact is unavailable.',
    )
  }
}

export async function loadOwnedSourceMarkdown(
  store: SourceContextStore,
  reader: CanonicalMarkdownReader,
  projectContextId: string,
  sourceRepresentationRevisionId: string,
): Promise<string> {
  const descriptor = await store
    .getSourceRepresentation(
      projectContextId,
      sourceRepresentationRevisionId,
    )
    .catch((cause) => {
      throw persistenceUnavailable(cause)
    })
  if (!descriptor)
    throw new ApiError(
      404,
      'not_found',
      'Project model context was not found.',
    )
  return readCanonicalMarkdown(reader, descriptor)
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

export async function loadOwnedSchemaModelContext(
  store: SchemaContextStore,
  reader: CanonicalMarkdownReader,
  pins: {
    projectContextId: string
    sourceRepresentationRevisionId: string
    extractionSchemaId: string
    schemaRevisionId: string
  },
): Promise<{
  documentMarkdown: string
  revision: SchemaRevisionRecord
}> {
  const [descriptor, revision] = await Promise.all([
    store.getSourceRepresentation(
      pins.projectContextId,
      pins.sourceRepresentationRevisionId,
    ),
    store.getSchemaRevision(
      pins.projectContextId,
      pins.extractionSchemaId,
      pins.schemaRevisionId,
    ),
  ]).catch((cause) => {
    throw persistenceUnavailable(cause)
  })
  if (!descriptor || !revision)
    throw new ApiError(
      404,
      'not_found',
      'Project model context was not found.',
    )
  return {
    documentMarkdown: await readCanonicalMarkdown(reader, descriptor),
    revision,
  }
}

export async function proposeSchemaEdit(
  nodes: readonly SchemaNode[],
  instruction: string,
  documentMarkdown: string | null,
  options: SchemaEditOptions = {},
): Promise<SchemaEditResponse> {
  const fields = enumerateFieldPaths(nodes)
  const duplicates = duplicateFieldKeys(fields)
  if (duplicates.length) {
    return { status: 'refused', message: `Duplicate field paths: ${duplicates.join(', ')}` }
  }

  const expected = new Map(fields.map((field) => [field.key, field]))
  const generate = options.generate ?? (async (prompt, temperature, target) =>
    (await generateSchemaEditJson(prompt, temperature, target)).text)

  try {
    const initial = await readEnvelope(await generate(
      schemaEditPrompt(fields.map(({ key, node }) => toPromptField(key, node)), instruction, documentMarkdown),
      options.temperature,
      options.target,
    ))
    const unknownIssues = unknownFieldIssues(initial.fields, expected)
    const additions = validatedAdditions(initial.additions, unknownIssues)
    const accepted = new Map<string, FieldEdit>()
    let unresolved = validateExpected(initial.fields, expected, accepted)

    if (unresolved.size) {
      try {
        const retryKeys = [...unresolved.keys()]
        const retryExpected = new Map(retryKeys.map((key) => [key, expected.get(key)!]))
        const retry = await readEnvelope(await generate(
          retryPrompt(retryKeys.map((key) => toPromptField(key, expected.get(key)!.node)), instruction),
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
      ...[...unresolved].map(([key, kind]) => ({ kind, key })),
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
  | { key: string; name: string; type: Exclude<SchemaNode['type'], 'array'> }
  | { key: string; name: string; type: 'array'; itemType: ScalarFieldType | null }

type PromptFieldValue =
  | { name: string; type: Exclude<SchemaNode['type'], 'array'> }
  | { name: string; type: 'array'; itemType: ScalarFieldType | null }

function toPromptField(key: string, node: SchemaNode): PromptField {
  if (node.type !== 'array') return { key, name: node.name, type: node.type }
  return {
    key,
    name: node.name,
    type: node.type,
    itemType: node.children === undefined ? node.itemType : null,
  }
}

function promptFieldValue(field: PromptField): PromptFieldValue {
  return field.type === 'array'
    ? { name: field.name, type: field.type, itemType: field.itemType }
    : { name: field.name, type: field.type }
}

function schemaEditPrompt(fields: readonly PromptField[], instruction: string, markdown: string | null): string {
  const source = markdown === null ? '' : `\n\nSOURCE DOCUMENT MARKDOWN:\n${markdown}\nEND SOURCE DOCUMENT MARKDOWN`
  return `You edit FREE Extraction Schemas for humanities researchers.

Researcher instruction: ${JSON.stringify(instruction)}
Existing fields, keyed by opaque identifiers that must be echoed exactly:
${JSON.stringify(Object.fromEntries(fields.map((field) => [field.key, promptFieldValue(field)])), null, 2)}${source}

Return one JSON object:
{"fields":{"opaque.key":{"name":"field_name","type":"${FIELD_TYPES.join('|')}","removed":false}},"additions":[{"path":["existing_parent","new_scalar"],"type":"string"},{"path":["existing_parent","new_dates"],"type":"array","itemType":"date"}]}

Rules:
- fields must contain every supplied opaque key exactly once, including unchanged and removed fields
- additions must always be present; use [] when no fields are added
- apply the researcher instruction to every relevant field; preserve only properties unrelated to that instruction
- itemType is allowed only when type is array; every array field and array addition requires itemType: a scalar type (${SCALAR_FIELD_TYPES.join('|')}) for a repeating scalar, or null for repeating records
- removed is true only for a removed existing field
- additions use full structural paths in the post-edit namespace and must not invent root path segments that are not existing or explicitly added fields
- return JSON only`
}

function retryPrompt(fields: readonly PromptField[], instruction: string): string {
  return `Repair only the missing or invalid field entries for this FREE schema edit.
Researcher instruction: ${JSON.stringify(instruction)}
Required opaque keys and current values:
${JSON.stringify(Object.fromEntries(fields.map((field) => [field.key, promptFieldValue(field)])), null, 2)}
Return {"fields":{...},"additions":[]} with every listed key exactly once. Use name, type (${FIELD_TYPES.join('|')}), removed, and itemType for arrays (scalar type or null for records). JSON only.`
}
