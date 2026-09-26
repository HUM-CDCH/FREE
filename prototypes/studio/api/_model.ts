import {
  APICallError,
  NoObjectGeneratedError,
  Output,
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import type { DocumentInput } from './_document.js'
import { documentFileParts, type DocumentFilePart } from './_pdf.js'
import { schemaPrompt, schemaSourceExcerpts } from './_schema.js'
import {
  ApiError,
  asModelOperationError,
} from './_http.js'
import { parseTemplate } from './_model_output.js'
import { readAccountModelConfig } from './_model_config.js'
import { ModelKeyRequiredError } from './_model_keys.js'
import type { ModelConfig } from '../shared/modelConfig.contract.js'
import {
  appendProviderResource,
  resolveCapabilityRoute,
  type ExecutionTarget,
  THINKING_OFF,
  type GeneralExecutionTarget,
  type ModelOperation,
  type NuExtractExecutionTarget,
  type RouteResolverDependencies,
} from './_provider.js'

export { parseInstruction, parseDocument } from './_document.js'
export { json, parseTemperature, type FormValue } from './_http.js'

const NON_THINKING_TEMPERATURE = 0.2

export type ModelGenerationMetadata = {
  readonly finishReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly durationMs: number
}

type GeneratedText = {
  readonly response: string
  readonly metadata: ModelGenerationMetadata
}

export type SchemaModelInput = {
  readonly document: DocumentInput
  readonly instruction: string
  readonly temperature?: number
  readonly signal?: AbortSignal
}

type DocumentContentPart = DocumentFilePart | { readonly type: 'text'; readonly text: string }
type NuExtractMode = 'template-generation'
/** Whose configuration and keys a model call uses: the Project Context's owner. Background and (from M4/M5) workflow
 *  calls carry only this ID and resolve the rest when the call runs. */
export type ModelCaller = Readonly<{ researcherAccountId: string }>
/** The resolver's seams, less the account: that is always the caller's, so no call can name another account's keys. */
type ModelDependencies = Omit<RouteResolverDependencies, 'readConfig' | 'researcherAccountId'> & {
  readConfig?: () => Promise<ModelConfig>
  fetch?: typeof fetch
}

async function documentContentParts(document: DocumentInput): Promise<{
  readonly parts: readonly DocumentContentPart[]
  readonly pages: number | null
}> {
  if (document.markdown) {
    return {
      parts: [{ type: 'text', text: document.markdown }],
      pages: document.pages,
    }
  }
  if (!document.file) {
    throw new ApiError(400, 'invalid_request', "No document content: provide a 'file' or 'document_markdown'")
  }
  const fileParts = await documentFileParts(document.file)
  return { parts: fileParts.parts, pages: fileParts.pages }
}

async function operationTarget(
  operation: ModelOperation,
  temperature: number | undefined,
  target: ExecutionTarget | undefined,
  caller: ModelCaller,
  dependencies: ModelDependencies,
): Promise<ExecutionTarget> {
  return target ?? resolveCapabilityRoute(operation, { temperature }, {
    ...dependencies,
    researcherAccountId: caller.researcherAccountId,
    readConfig: dependencies.readConfig ?? (() => readAccountModelConfig(caller.researcherAccountId)),
  })
}

/** `signal` is the browser's request: when it goes away the stream, and any wait for a key, ends. */
export async function streamChatWithModel(
  caller: ModelCaller,
  messages: readonly UIMessage[],
  documentMarkdown: string,
  temperature?: number,
  signal?: AbortSignal,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<Response> {
  const resolved = await operationTarget('chat', temperature, target, caller, dependencies)
  if (resolved.profile !== 'general') {
    throw new ApiError(409, 'invalid_model_config', 'The Interaction Route must use general execution.')
  }
  try {
    const result = streamText({
      model: resolved.model,
      system:
        'Answer questions using the source document below. Say when the source does not support an answer.\n\n' +
        `SOURCE DOCUMENT MARKDOWN:\n${documentMarkdown}\nEND SOURCE DOCUMENT MARKDOWN`,
      messages: await convertToModelMessages([...messages]),
      ...(temperature === undefined ? {} : { temperature }),
      abortSignal: signal,
      // The SDK's default logs the whole error: the provider's response body, the request and, for a key that is no
      // valid header value, a runtime message quoting `Bearer <key>`. Log only the error's class and HTTP status.
      onError: ({ error }) => {
        if (error instanceof ModelKeyRequiredError) return
        console.error('chat_failed:', {
          error: error instanceof Error ? error.constructor.name : typeof error,
          statusCode: APICallError.isInstance(error) ? error.statusCode ?? null : null,
        })
      },
    })
    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        // Only a missing key is named: the page resends its keys and the researcher can try again.
        onError: (error) => (error instanceof ModelKeyRequiredError ? error.message : 'Chat failed.'),
      }),
    })
  } catch (error) {
    throw asModelOperationError(error, 'Chat failed before streaming began.')
  }
}

export async function generateSchemaWithModel(
  caller: ModelCaller,
  { document, instruction, temperature, signal }: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{
  readonly template: Record<string, unknown>
  readonly raw: string
  readonly pages: number | null
}> {
  const resolved = await operationTarget('schema-suggestion', temperature, target, caller, dependencies)
  const documentParts = await documentContentParts({
    ...document,
    markdown: document.markdown ? schemaSourceExcerpts(document.markdown) : document.markdown,
  })
  const guidance = schemaPrompt(instruction)
  const generated =
    resolved.profile === 'general'
      ? await generateWithGenericJsonPrompt(resolved, {
          instructions:
            'Propose a compact extraction schema grounded in the supplied source document. ' +
            'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
          request: guidance,
          documentParts: documentParts.parts,
          temperature,
          signal,
        })
      : await generateWithNuExtract(resolved, {
          mode: 'template-generation',
          documentParts: [{ type: 'text', text: guidance }, ...documentParts.parts],
          temperature,
          signal,
        }, dependencies.fetch)
  const parsed = await parseTemplate(generated.response)
  if (
    typeof parsed._description !== 'string' ||
    parsed._description.trim().length === 0
  )
    throw new ApiError(
      502,
      'invalid_model_output',
      'The generated Extraction Schema has no root record description.',
    )
  return {
    template: parsed,
    raw: generated.response,
    pages: documentParts.pages ?? document.pages,
  }
}

// ponytail: remember at most 256 routes per process; persist only if restart retries matter.
const promptOnlyRoutes = new Set<string>()

async function generateWithRouteOutput(target: GeneralExecutionTarget, options: Parameters<typeof generateText>[0]) {
  const key = target.automaticOutputKey
  const request = key && promptOnlyRoutes.has(key) ? { ...options, output: undefined } : options
  try {
    return await generateText(request)
  } catch (error) {
    // Retry only an explicit unsupported output feature, never auth, transport, or schema-validation errors.
    if (!key || !request.output || !APICallError.isInstance(error) ||
      ![400, 422].includes(error.statusCode ?? 0) ||
      !/(?:response_format|output_config|output_format|json_schema|structured outputs?)['"`\s]*(?:is |are )?(?:not supported|unsupported)|(?:unsupported|unknown|unrecognized) (?:parameter|field|argument)[:\s'"]+(?:response_format|output_config|output_format)/i.test(error.message)) throw error
    if (promptOnlyRoutes.size >= 256) promptOnlyRoutes.delete(promptOnlyRoutes.values().next().value!)
    promptOnlyRoutes.add(key)
    return generateText({ ...options, output: undefined })
  }
}

async function generateWithGenericJsonPrompt(
  target: GeneralExecutionTarget,
  input: {
    readonly instructions: string
    readonly request: string
    readonly documentParts: readonly DocumentContentPart[]
    readonly temperature?: number
    readonly signal?: AbortSignal
  },
): Promise<GeneratedText> {
  const startedAt = performance.now()
  // Schema-free JSON mode where the route has one; otherwise the prompt asks for JSON.
  const structuredOutput = target.jsonOutput === 'native' ? Output.json() : undefined
  try {
    const generated = await generateWithRouteOutput(target, {
      model: target.model,
      ...(structuredOutput ? { output: structuredOutput } : {}),
      instructions: input.instructions,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${input.request}\n\nSOURCE DOCUMENT:\n` },
            ...input.documentParts,
            { type: 'text', text: '\nEND SOURCE DOCUMENT\n\nReturn the JSON object now.' },
          ],
        },
      ],
      reasoning: 'none',
      abortSignal: input.signal,
      ...(target.temperatureSupported ? { temperature: input.temperature ?? 0 } : {}),
    })
    return {
      response: generated.text,
      metadata: {
        finishReason: generated.finishReason ?? null,
        inputTokens: generated.usage?.inputTokens ?? null,
        outputTokens: generated.usage?.outputTokens ?? null,
        durationMs: Math.round(performance.now() - startedAt),
      },
    }
  } catch (error) {
    if (structuredOutput && NoObjectGeneratedError.isInstance(error)) {
      return {
        response: error.text ?? '',
        metadata: {
          finishReason: error.finishReason ?? null,
          inputTokens: error.usage?.inputTokens ?? null,
          outputTokens: error.usage?.outputTokens ?? null,
          durationMs: Math.round(performance.now() - startedAt),
        },
      }
    }
    throw asModelOperationError(error)
  }
}

/**
 * NuExtract3 takes its task from its chat template's kwargs, which vLLM passes
 * through: `mode` selects the task and the document is the only user message.
 * Only `structured` mode has an instructions slot, so guidance for
 * `template-generation` leads the document content in the message itself.
 */
async function generateWithNuExtract(
  target: NuExtractExecutionTarget,
  input: {
    readonly mode: NuExtractMode
    readonly documentParts: readonly DocumentContentPart[]
    readonly temperature?: number
    readonly signal?: AbortSignal
  },
  requestFetch: typeof fetch = fetch,
): Promise<GeneratedText> {
  const startedAt = performance.now()
  // The key is read inside the attempt, so a missing one waits for a page to resend it; nothing is sent after an abort.
  let authorization: string | null
  try {
    const key = await target.key(input.signal)
    authorization = key === null ? null : `Bearer ${key}`
  } catch (error) {
    // model_key_required passes through unchanged.
    throw asModelOperationError(error, 'NuExtract generation failed.')
  }
  input.signal?.throwIfAborted()
  const url = appendProviderResource(target.baseUrl, 'chat/completions')
  const requestBody = JSON.stringify({
    model: target.modelId,
    messages: [{ role: 'user', content: input.documentParts.map(chatContentPart) }],
    chat_template_kwargs: { mode: input.mode, ...THINKING_OFF },
    temperature: input.temperature ?? NON_THINKING_TEMPERATURE,
    max_tokens: 8192,
  })
  let response: Response
  try {
    response = await requestFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization === null ? {} : { authorization }),
      },
      body: requestBody,
      signal: input.signal,
    })
  } catch (error) {
    throw asModelOperationError(error, 'NuExtract generation failed.')
  }

  const bodyText = await response.text()
  if (!response.ok) {
    throw new ApiError(502, 'model_operation_failed', 'NuExtract generation failed.')
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch (cause) {
    throw new ApiError(502, 'invalid_model_output', 'NuExtract returned an invalid chat completion.', { cause })
  }
  const parsed = chatCompletionSchema.safeParse(body)
  if (!parsed.success) {
    throw new ApiError(502, 'invalid_model_output', 'NuExtract returned an invalid chat completion.', {
      cause: parsed.error,
    })
  }
  const [choice] = parsed.data.choices
  return {
    response: choice.message.content,
    metadata: {
      finishReason: choice.finish_reason ?? null,
      inputTokens: parsed.data.usage?.prompt_tokens ?? null,
      outputTokens: parsed.data.usage?.completion_tokens ?? null,
      durationMs: Math.round(performance.now() - startedAt),
    },
  }
}

function chatContentPart(part: DocumentContentPart) {
  if (part.type === 'text') return { type: 'text', text: part.text }
  const data = typeof part.data === 'string'
    ? (part.data.split(',', 2)[1] ?? part.data)
    : Buffer.from(part.data).toString('base64')
  return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${data}` } }
}

const chatCompletionSchema = z.object({
  choices: z.tuple([z.object({
    message: z.object({ content: z.string() }),
    finish_reason: z.string().nullable().optional(),
  })]).rest(z.unknown()),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
})

/** `signal` is the browser's request: when it goes away the call, and any wait for a key, ends. */
export async function generateSchemaEditJson(
  caller: ModelCaller,
  prompt: string,
  temperature?: number,
  signal?: AbortSignal,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{ text: string }> {
  const resolved = await operationTarget('schema-edit', temperature, target, caller, dependencies)
  if (resolved.profile !== 'general') {
    throw new ApiError(409, 'invalid_model_config', 'The Interaction Route must use general execution.')
  }
  try {
    const result = await generateWithRouteOutput(resolved, {
      model: resolved.model,
      ...(resolved.jsonOutput === 'native' ? { output: Output.json() } : {}),
      reasoning: 'none',
      messages: [{ role: 'user', content: prompt }],
      ...(temperature === undefined ? {} : { temperature }),
      abortSignal: signal,
    })
    if (result.finishReason === 'length') {
      throw new ApiError(502, 'invalid_model_output', 'Schema edit model output was truncated.')
    }
    return { text: result.text.replace(/```(?:json)?|```/g, '').trim() }
  } catch (error) {
    throw asModelOperationError(error)
  }
}
