import { cascadeRepairText } from 'ai-sdk-ollama'
import { z } from 'zod'
import { ApiError } from './_http.js'

const templateEnvelopeSchema = z.object({
  template: z.record(z.string(), z.unknown()),
})

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
    throw new ApiError(502, 'invalid_model_output', message, { cause: parsed.error })
  }
  throw parsed.error
}

async function parseJsonObject(text: string, message: string): Promise<Record<string, unknown>> {
  const parsed = await parseUnknownJson(text.replace(/<think>[\s\S]*?<\/think>/, '').trim(), message)
  if (!isRecord(parsed)) {
    throw new ApiError(502, 'invalid_model_output', message)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
