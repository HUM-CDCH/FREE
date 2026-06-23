import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, type LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import {
  DEFAULT_PROVIDER_SETTINGS,
  normalizeProviderSettings,
  type AiProviderSettings,
} from './provider-settings'

export type TemplateAnnotation = { text: string; pageNumber: number }
export type AnnotationsMode = 'hints' | 'fields'

const TEMPLATE_GENERATION_TASK_INSTRUCTIONS =
  'Generate a concise NuExtract JSON template for the supplied document. Use descriptive field names. Use leaf types such as verbatim-string, string, integer, number, date, date-time, time, country, currency, or email. Use JSON objects for nested groups and arrays such as ["string"] or [{"field":"verbatim-string"}] for repeated values. Return only the JSON template.'

const STRUCTURED_TASK_INSTRUCTIONS = `You will extract structured information from the CONTEXT using the INPUT SCHEMA (JSON) below and return exactly ONE JSON object that matches the INPUT SCHEMA.

Return ONLY a single JSON object. No prose, no code fences, no explanations, no backticks.
Extract ONLY what the schema asks for. Do not add nodes.
If a value is missing or cannot be confidently determined, use null for leaf fields and [] for arrays.
Every value must be supported by the source document.`

type TemplateKwargs = Record<string, unknown>

type PreparedModel = {
  model: LanguageModel
  controlChannel: 'message-text' | 'template-kwargs'
  templateKwargs: TemplateKwargs
}

export type ProviderRequestInput = {
  providerSettings: unknown
  templateKwargs?: TemplateKwargs
}

// Each rasterised page (a data URL from the client) becomes an image/jpeg file
// part. Both providers route image/* correctly: openai-compatible -> image_url,
// ollama -> images[]. Raw PDF parts never reach the vision model — see
// app/components/rasterize.ts for why we send images instead.
function imageParts(pageDataUrls: string[]) {
  return pageDataUrls.map((dataUrl, index) => {
    const match = /^data:image\/jpeg;base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUrl)
    if (!match) {
      throw new Error(`Page ${index + 1} is not a valid JPEG data URL`)
    }
    const data = Buffer.from(match[1], 'base64')
    if (data.length === 0) {
      throw new Error(`Page ${index + 1} is empty`)
    }
    return {
      type: 'file' as const,
      data,
      mediaType: 'image/jpeg',
      filename: `page-${index + 1}.jpg`,
    }
  })
}

export function parseAnnotations(value: FormDataEntryValue | null): TemplateAnnotation[] {
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('annotations must be a JSON array')
  }
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    const pageNumber = typeof record.pageNumber === 'number' ? record.pageNumber : Number(record.pageNumber)
    return text && Number.isInteger(pageNumber) && pageNumber >= 1 ? [{ text, pageNumber }] : []
  })
}

export function annotationGuidance(annotations: TemplateAnnotation[], mode: AnnotationsMode) {
  if (annotations.length === 0) {
    return ''
  }
  const modeText =
    mode === 'fields'
      ? 'Use the annotations as the primary signal for which fields the extraction schema should include, using the rest of the document only as context.'
      : 'Design the extraction schema from the whole source document, and treat annotations as additional guidance for field coverage.'
  return `${modeText}\n\nAnnotations from source document:\n${annotations
    .map((annotation) => `- page ${annotation.pageNumber}: ${annotation.text}`)
    .join('\n')}`
}

export async function runTemplateGeneration({
  pages,
  annotations,
  annotationsMode,
  providerSettings,
}: {
  pages: string[]
  annotations: TemplateAnnotation[]
  annotationsMode: AnnotationsMode
  providerSettings: unknown
}) {
  const guidance = annotationGuidance(annotations, annotationsMode)
  const sourceParts = imageParts(pages)
  const prepared = prepareModel({ providerSettings, templateKwargs: { mode: 'template-generation', enable_thinking: false } })
  const content =
    prepared.controlChannel === 'message-text'
      ? [
          { type: 'text' as const, text: TEMPLATE_GENERATION_TASK_INSTRUCTIONS },
          ...sourceParts,
          ...(guidance ? [{ type: 'text' as const, text: guidance }] : []),
        ]
      : [...sourceParts, ...(guidance ? [{ type: 'text' as const, text: guidance }] : [])]

  const result = await generateText({
    model: prepared.model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    maxOutputTokens: 10000,
  })

  return {
    template: parseResult(prettyJsonOrText(result.text)),
    raw: result.text,
    pages: sourceParts.length,
  }
}

export async function runStructuredExtraction({
  pages,
  template,
  providerSettings,
}: {
  pages: string[]
  template: unknown
  providerSettings: unknown
}) {
  const templateJson = JSON.stringify(template ?? {}, null, 2)
  const sourceParts = imageParts(pages)
  const prepared = prepareModel({
    providerSettings,
    templateKwargs: {
      enable_thinking: false,
      template: templateJson,
      instructions: STRUCTURED_TASK_INSTRUCTIONS,
    },
  })
  const content =
    prepared.controlChannel === 'message-text'
      ? [
          { type: 'text' as const, text: STRUCTURED_TASK_INSTRUCTIONS },
          ...sourceParts,
          { type: 'text' as const, text: `Extraction schema:\n${templateJson}` },
        ]
      : [...sourceParts]

  const result = await generateText({
    model: prepared.model,
    messages: [{ role: 'user', content }],
    temperature: 0.2,
    maxOutputTokens: 10000,
  })

  return {
    result: parseJsonObjectResult(extractAnswerBlock(result.text)),
    reasoning: null,
    raw: result.text,
    pages: sourceParts.length,
  }
}

export function prepareChatModel(providerSettings: unknown): LanguageModel {
  return prepareModel({ providerSettings, templateKwargs: { enable_thinking: false } }).model
}

function prepareModel({ providerSettings, templateKwargs = {} }: ProviderRequestInput): PreparedModel {
  const settings = normalizeProviderSettings(providerSettings)
  if (settings.provider === 'docker-runner') {
    const provider = createOpenAICompatible({
      name: 'docker-runner',
      baseURL: settings.baseURL || DEFAULT_PROVIDER_SETTINGS['docker-runner'].baseURL,
      apiKey: 'EMPTY',
      transformRequestBody: (body) => ({ ...body, chat_template_kwargs: templateKwargs }),
    })
    return { model: provider(settings.model), controlChannel: 'template-kwargs', templateKwargs }
  }

  const provider = createOllama({
    baseURL: settings.baseURL || DEFAULT_PROVIDER_SETTINGS.ollama.baseURL,
  })
  return { model: provider(settings.model), controlChannel: 'message-text', templateKwargs }
}

function extractAnswerBlock(output: string) {
  const match = output.match(/<answer>([\s\S]*?)<\/answer>/i)
  return (match?.[1] ?? output).trim()
}

function prettyJsonOrText(output: string) {
  const text = stripCodeFence(output.trim())
  const json = firstJsonObject(text)
  return json ?? text
}

function parseResult(output: string): unknown {
  const text = stripCodeFence(output.trim())
  const json = firstJsonObject(text) ?? text
  try {
    return JSON.parse(json)
  } catch {
    return text
  }
}

function parseJsonObjectResult(output: string): Record<string, unknown> {
  const text = stripCodeFence(output.trim())
  const json = firstJsonObject(text) ?? text
  const parsed = JSON.parse(json) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model returned JSON that is not an object')
  }
  return parsed as Record<string, unknown>
}

function stripCodeFence(text: string) {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return (fence?.[1] ?? text).trim()
}

function firstJsonObject(text: string) {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (start === -1) {
      if (character === '{') {
        start = index
        depth = 1
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, index + 1)
      }
    }
  }

  return null
}
