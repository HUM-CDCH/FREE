import { cascadeRepairText } from 'ai-sdk-ollama'
import { z } from 'zod'
import { RequestError } from './_http'

const templateEnvelopeSchema = z.object({
  template: z.record(z.string(), z.unknown()),
})

export async function parseExtractionResult(text: string, template: unknown): Promise<Record<string, unknown>> {
  const message = 'Model returned output that did not match the extraction schema.'
  const object = await parseJsonObject(text, message)
  const conformed = conformToSchema(object, template)
  if (!isRecord(conformed)) {
    throw new RequestError(502, message, text)
  }
  return conformed
}

/** Faithful port of FREE-technical's pinned `_conform_to_schema` behavior. */
export function conformToSchema(data: unknown, schema: unknown): unknown {
  if (isRecord(schema)) {
    if (Object.keys(schema).length === 0) {
      return isRecord(data) ? data : {}
    }
    const source = isRecord(data) ? data : {}
    return Object.fromEntries(
      Object.entries(schema).map(([key, childSchema]) => [key, conformToSchema(source[key], childSchema)]),
    )
  }

  if (Array.isArray(schema)) {
    if (data === null || data === undefined) {
      return []
    }
    const source = Array.isArray(data) ? data : [data]
    if (schema.length === 0) {
      return source
    }
    return source.map((item) => conformToSchema(item, schema[0]))
  }

  return data === null || data === undefined || isScalar(data) ? (data ?? null) : null
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

type JsonParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Error }

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

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
