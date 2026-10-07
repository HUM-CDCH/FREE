import { jsonrepair } from 'jsonrepair'
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

/**
 * Parse valid JSON before touching its text, preserving literal tags and fences
 * inside values. Otherwise remove outer framing, then use jsonrepair for syntax
 * that still cannot be parsed.
 */
export async function parseUnknownJson(text: string, message: string): Promise<unknown> {
  const parsed = tryParseJson(text)
  if (parsed.ok) {
    return unwrapJsonString(parsed.value)
  }

  const unframedText = withoutOuterFraming(text)
  const unframed = tryParseJson(unframedText)
  if (unframed.ok) {
    return unwrapJsonString(unframed.value)
  }
  try {
    return unwrapJsonString(JSON.parse(jsonrepair(unframedText)))
  } catch (cause) {
    throw new ApiError(502, 'invalid_model_output', message, { cause })
  }
}

const LEADING_REASONING = /^\s*<think>[\s\S]*?<\/think>\s*/
const OUTER_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/

function withoutOuterFraming(text: string): string {
  const reply = text.replace(LEADING_REASONING, '').trim()
  return OUTER_FENCE.exec(reply)?.[1] ?? reply
}

async function parseJsonObject(text: string, message: string): Promise<Record<string, unknown>> {
  const parsed = await parseUnknownJson(text, message)
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
