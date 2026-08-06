import { z } from 'zod'
import {
  fieldEditSchema,
  schemaAdditionSchema,
  type FieldEdit,
  type SchemaAddition,
  type SchemaEditIssue,
  type SchemaEditResponse,
} from '../shared/schemaEdit.contract.js'
import {
  duplicateFieldKeys,
  enumerateFieldPaths,
  type SchemaNode,
} from '../shared/schemaNode.js'
import {
  FIELD_TYPES,
  NON_STRING_SCALAR_FIELD_TYPES,
  SCALAR_FIELD_TYPES,
  isAllowedValues,
  type ScalarFieldType,
} from '../shared/allowedValues.js'
import { parseUnknownJson } from './_model_output.js'
import { generateSchemaEditJson } from './_model.js'
import type { ExecutionTarget } from './_provider.js'
import { ApiError } from './_http.js'

const nodeBaseShape = {
  id: z.string().min(1),
  name: z.string().trim().min(1),
  description: z.string().min(1).optional(),
}

const schemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() => z.union([
  z.object({
    ...nodeBaseShape,
    type: z.literal('string'),
    allowedValues: z.array(z.string()).refine(isAllowedValues).optional(),
  }).strict(),
  z.object({
    ...nodeBaseShape,
    type: z.enum(NON_STRING_SCALAR_FIELD_TYPES),
  }).strict(),
  z.object({
    ...nodeBaseShape,
    type: z.literal('array'),
    itemType: z.enum(SCALAR_FIELD_TYPES),
  }).strict(),
  z.object({
    ...nodeBaseShape,
    type: z.enum(['object', 'array']),
    children: z.array(schemaNodeSchema),
  }).strict(),
]))

const modelEnvelopeSchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  additions: z.unknown(),
}).passthrough()

export function parseSchemaNodes(value: unknown): SchemaNode[] {
  return z.array(schemaNodeSchema).parse(value)
}

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
        if (error instanceof ApiError) throw error
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
    if (error instanceof ApiError) throw error
    return { status: 'failed', message: 'Schema edit generation failed.' }
  }
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
{"fields":{"opaque.key":{"name":"field_name","type":"${FIELD_TYPES.join('|')}","removed":false}},"additions":[{"path":["post_edit_parent","new_field"],"type":"array","itemType":"date"}]}

Rules:
- fields must contain every supplied opaque key exactly once, including unchanged and removed fields
- name, type, and array itemType are the only editable properties
- every array field and addition requires itemType: a scalar type (${SCALAR_FIELD_TYPES.join('|')}) for a repeating scalar, or null for repeating records
- removed is true only for a removed existing field
- additions use full structural paths in the post-edit namespace
- return JSON only`
}

function retryPrompt(fields: readonly PromptField[], instruction: string): string {
  return `Repair only the missing or invalid field entries for this FREE schema edit.
Researcher instruction: ${JSON.stringify(instruction)}
Required opaque keys and current values:
${JSON.stringify(Object.fromEntries(fields.map((field) => [field.key, promptFieldValue(field)])), null, 2)}
Return {"fields":{...},"additions":[]} with every listed key exactly once. Use name, type (${FIELD_TYPES.join('|')}), removed, and itemType for arrays (scalar type or null for records). JSON only.`
}
