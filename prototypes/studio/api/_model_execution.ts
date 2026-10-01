import { SpanKind } from '@opentelemetry/api'
import {
  APICallError,
  NoObjectGeneratedError,
  Output,
  generateText,
} from 'ai'
import { z } from 'zod'
import type { DocumentFilePart } from './_pdf.js'
import {
  ApiError,
  asModelOperationError,
} from './_http.js'
import { withStepCancellation } from './_model_keys.js'
import { readAccountModelConfig } from './_model_config.js'
import type { ModelConfig } from '../shared/modelConfig.contract.js'
import { captures, inSpan } from '../server/tracing.js'
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

const NON_THINKING_TEMPERATURE = 0.2

export type DocumentContentPart = DocumentFilePart | { readonly type: 'text'; readonly text: string }
type NuExtractMode = 'template-generation'
/** Whose configuration and keys a model call uses: the Project Context's owner. Background and (from M4/M5) workflow
 *  calls carry only this ID and resolve the rest when the call runs. */
export type ModelCaller = Readonly<{ researcherAccountId: string }>
/** The resolver's seams, less the account: that is always the caller's, so no call can name another account's keys. */
export type ModelDependencies = Omit<RouteResolverDependencies, 'readConfig' | 'researcherAccountId'> & {
  readConfig?: () => Promise<ModelConfig>
  fetch?: typeof fetch
}

export async function resolveModelTarget(
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

// ponytail: remember at most 256 routes per process; persist only if restart retries matter.
const promptOnlyRoutes = new Set<string>()

async function generateWithRouteOutput(target: GeneralExecutionTarget, untraced: Parameters<typeof generateText>[0]) {
  // The AI SDK records prompts and responses unless told not to.
  const options = { ...untraced, telemetry: { recordInputs: captures('prompts'), recordOutputs: captures('responses') } }
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

/** Protocol selection and guidance placement live with execution, not the durable caller. */
export async function executeSchemaSuggestion(
  target: ExecutionTarget,
  input: {
    readonly instructions: string
    readonly guidance: string
    readonly documentParts: readonly DocumentContentPart[]
    readonly temperature?: number
    readonly signal?: AbortSignal
  },
  requestFetch?: typeof fetch,
): Promise<{ response: string }> {
  return target.profile === 'general'
    ? generateWithGenericJsonPrompt(target, {
        instructions: input.instructions,
        request: input.guidance,
        documentParts: input.documentParts,
        temperature: input.temperature,
        signal: input.signal,
      })
    : generateWithNuExtract(target, {
        mode: 'template-generation',
        documentParts: [{ type: 'text', text: input.guidance }, ...input.documentParts],
        temperature: input.temperature,
        signal: input.signal,
      }, requestFetch)
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
): Promise<{ response: string }> {
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
    if (generated.finishReason === 'length') throw OUTPUT_TRUNCATED
    return { response: generated.text }
  } catch (error) {
    if (structuredOutput && NoObjectGeneratedError.isInstance(error)) {
      if (error.finishReason === 'length') throw OUTPUT_TRUNCATED
      return { response: error.text ?? '' }
    }
    throw asModelOperationError(error)
  }
}

/** A schema the model stopped writing for length: even when it parses, fields may be missing, so it is not a result. */
const OUTPUT_TRUNCATED = new ApiError(502, 'model_output_truncated', 'The model stopped before finishing its answer.')

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
): Promise<{ response: string }> {
  // The attempt's signal carries the step's cancel signal (Task 2): a cancelled workflow ends the key wait or the fetch.
  const signal = withStepCancellation(input.signal)
  // The key is read inside the attempt, so a missing one waits for a page to resend it; nothing is sent after an abort.
  let authorization: string | null
  try {
    const key = await target.key(signal)
    authorization = key === null ? null : `Bearer ${key}`
  } catch (error) {
    // model_key_required passes through unchanged.
    throw asModelOperationError(error, 'NuExtract generation failed.')
  }
  signal?.throwIfAborted()
  const url = appendProviderResource(target.baseUrl, 'chat/completions')
  const requestBody = JSON.stringify({
    model: target.modelId,
    messages: [{ role: 'user', content: input.documentParts.map(chatContentPart) }],
    chat_template_kwargs: { mode: input.mode, ...THINKING_OFF },
    temperature: input.temperature ?? NON_THINKING_TEMPERATURE,
    max_tokens: 8192,
  })
  // The AI SDK traces the general path; this span is the same record for NuExtract's raw chat completion.
  const attributes = { 'openinference.span.kind': 'LLM', 'llm.model_name': target.modelId }
  return inSpan(`chat ${target.modelId}`, { kind: SpanKind.CLIENT, attributes }, async (span) => {
    if (captures('prompts')) span.setAttributes({ 'input.value': requestBody, 'input.mime_type': 'application/json' })
    let response: Response
    try {
      response = await requestFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === null ? {} : { authorization }),
        },
        body: requestBody,
        signal,
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
    if (choice.finish_reason === 'length') throw OUTPUT_TRUNCATED
    span.setAttributes({
      'llm.token_count.prompt': parsed.data.usage?.prompt_tokens,
      'llm.token_count.completion': parsed.data.usage?.completion_tokens,
      ...(captures('responses') ? { 'output.value': choice.message.content } : {}),
    })
    return { response: choice.message.content }
  })
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

/** The request signal and DBOS cancellation are composed at the provider/key boundary. */
export async function executeEditPrompt(
  caller: ModelCaller,
  prompt: string,
  temperature?: number,
  signal?: AbortSignal,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{ text: string; finishReason: string }> {
  const resolved = await resolveModelTarget('schema-edit', temperature, target, caller, dependencies)
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
    return { text: result.text, finishReason: result.finishReason }
  } catch (error) {
    throw asModelOperationError(error)
  }
}
