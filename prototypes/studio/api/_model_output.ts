import { cascadeRepairText } from 'ai-sdk-ollama'
import { z } from 'zod'
import { RequestError } from './_http'

const templateEnvelopeSchema = z.object({
  template: z.record(z.string(), z.unknown()),
})

export async function parseExtractionResult(text: string, template: unknown): Promise<Record<string, unknown>> {
  const message = 'Model returned output that did not match the extraction schema.'
  const object = await parseJsonObject(text, message)
  const parsed = extractionResultSchema(template).safeParse(object)
  if (!parsed.success || !isRecord(parsed.data)) {
    // ponytail: schema mismatch is a warning, not a failure — return the raw JSON object so partial results survive
    console.warn(message, parsed.success ? object : parsed.error.issues)
    return object
  }
  return parsed.data
}

export async function parseTemplate(text: string): Promise<Record<string, unknown>> {
  const object = await parseJsonObject(text, 'Model returned an invalid extraction schema.')
  const envelope = templateEnvelopeSchema.safeParse(object)
  return envelope.success ? envelope.data.template : object
}

export async function parseUnknownJson(text: string, message: string): Promise<unknown> {
  const parsed = tryParseJson(text)
  if (parsed.ok) {
    return unwrapJsonString(parsed.value)
  }

  const repaired = await cascadeRepairText({ text, error: parsed.error })
  if (repaired !== null) {
    const repairedParsed = tryParseJson(repaired)
    if (repairedParsed.ok) {
      return unwrapJsonString(repairedParsed.value)
    }
  }

  if (parsed.error instanceof SyntaxError) {
    throw new RequestError(502, message, text)
  }
  throw parsed.error
}

async function parseJsonObject(text: string, message: string): Promise<Record<string, unknown>> {
  const parsed = await parseUnknownJson(text.replace(/<think>[\s\S]*?<\/think>/, '').trim(), message)
  if (!isRecord(parsed)) {
    throw new RequestError(502, message, text)
  }
  return parsed
}

type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Error }

function tryParseJson(text: string): JsonParseResult {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error }
    }
    throw error
  }
}

function unwrapJsonString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  if (!looksLikeJsonContainer(trimmed)) {
    return value
  }

  const parsed = tryParseJson(trimmed)
  return parsed.ok ? parsed.value : value
}

function looksLikeJsonContainer(text: string): boolean {
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))
}

function extractionResultSchema(template: unknown): z.ZodType<unknown> {
  if (!isRecord(template)) {
    return z.record(z.string(), z.unknown())
  }
  return objectSchemaFromTemplate(template)
}

function objectSchemaFromTemplate(template: Record<string, unknown>): z.ZodType<unknown> {
  const shape: Record<string, z.ZodType<unknown>> = {}
  for (const [key, value] of Object.entries(template)) {
    shape[key] = valueSchemaFromTemplate(value)
  }
  return z.object(shape).strict()
}

function valueSchemaFromTemplate(value: unknown): z.ZodType<unknown> {
  if (Array.isArray(value)) {
    return z.array(valueSchemaFromTemplate(value[0] ?? 'string')).nullable()
  }

  if (isRecord(value)) {
    return objectSchemaFromTemplate(value).nullable()
  }

  return primitiveSchemaFromLabel(String(value)).nullable()
}

function primitiveSchemaFromLabel(label: string): z.ZodType<unknown> {
  switch (label) {
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'object':
      return z.record(z.string(), z.unknown())
    case 'array':
      return z.array(z.unknown())
    default:
      return z.string()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
