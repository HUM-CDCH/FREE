import { randomUUID } from 'node:crypto'
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai'
import type { LlmTrace, LlmTraceStatus } from '../shared/llmInspector.contract.js'
import type { ExecutionTarget, ModelOperation, NuExtractRawExecutionTarget } from './_provider.js'

const TRACE_LIMIT = 50
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-goog-api-key|x-api-key|api[-_]?key|token|x-auth-token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|credential|password)$/i

const traces: LlmTrace[] = []
const inspectedModels = new WeakSet<object>()

function collectSecrets(value: unknown, found: Set<string>, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && typeof item === 'string' && item.length > 0) found.add(item)
    else collectSecrets(item, found, seen)
  }
}

function redactString(value: string, secrets: Set<string>): string {
  let redacted = value
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED_HASH]')
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[REDACTED_PATH]')
    .replace(
      /(^|[\s"'(])\/(?:home|Users|var|tmp|private|opt|srv)(?:\/[^\s"')}]*)?/g,
      '$1[REDACTED_PATH]',
    )
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"',}]+/gi, (match) => {
    try {
      const url = new URL(match)
      if (url.username) url.username = '[REDACTED]'
      if (url.password) url.password = '[REDACTED]'
      for (const key of url.searchParams.keys()) if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]')
      return url.toString()
    } catch {
      return match
    }
  })
}

function payload(value: unknown, secrets = new Set<string>()): string {
  const ancestors: object[] = []
  collectSecrets(value, secrets)
  try {
    return JSON.stringify(value, function (key, item: unknown) {
      if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
      if (typeof item === 'string') return redactString(item, secrets)
      if (typeof item === 'bigint') return item.toString()
      if (item instanceof Error) return { name: item.name, message: item.message }
      if (typeof item === 'object' && item !== null) {
        while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
        if (ancestors.includes(item)) return '[Circular]'
        ancestors.push(item)
      }
      return item
    }, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function errorPayload(error: unknown, secrets: Set<string>): string {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  return payload({
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : 'The model operation failed.',
    ...(record.details === undefined ? {} : { details: record.details }),
  }, secrets)
}

function startTrace(operation: ModelOperation, target: ExecutionTarget, request: unknown) {
  const secrets = new Set<string>()
  collectSecrets(request, secrets)
  const model = target.profile === 'nuextract-raw'
    ? { provider: 'ollama', modelId: target.modelId }
    : target.model as unknown as { provider?: string; modelId?: string }
  const trace: LlmTrace = {
    id: randomUUID(),
    operation,
    provider: model.provider ?? 'configured-provider',
    model: model.modelId ?? 'configured-model',
    profile: target.profile,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    request: payload(request, secrets),
    response: null,
  }
  traces.unshift(trace)
  if (traces.length > TRACE_LIMIT) traces.length = TRACE_LIMIT

  const finish = (status: LlmTraceStatus, response: unknown) => {
    trace.status = status
    trace.completedAt = new Date().toISOString()
    trace.response = status === 'failed' && response instanceof Error
      ? errorPayload(response, secrets)
      : payload(response, secrets)
  }
  return {
    complete: (response: unknown) => finish('complete', response),
    fail: (error: unknown) => finish('failed', error),
    cancel: (reason: unknown) => finish('cancelled', reason ?? { message: 'The model operation was cancelled.' }),
  }
}

type StreamResult = Awaited<ReturnType<Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

function inspectorMiddleware(operation: ModelOperation, target: ExecutionTarget): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate, params }) {
      const trace = startTrace(operation, target, params)
      try {
        const result = await doGenerate()
        trace.complete(result)
        return result
      } catch (error) {
        trace.fail(error)
        throw error
      }
    },
    async wrapStream({ doStream, params }) {
      const trace = startTrace(operation, target, params)
      let result: StreamResult
      try {
        result = await doStream()
      } catch (error) {
        trace.fail(error)
        throw error
      }
      const reader = result.stream.getReader()
      const chunks: StreamPart[] = []
      let streamFailed = false
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              if (!streamFailed) trace.complete({ request: result.request, response: result.response, chunks })
              controller.close()
              reader.releaseLock()
              return
            }
            chunks.push(next.value)
            if (next.value.type === 'error') {
              streamFailed = true
              trace.fail(next.value.error)
            }
            controller.enqueue(next.value)
          } catch (error) {
            trace.fail(error)
            controller.error(error)
            reader.releaseLock()
          }
        },
        async cancel(reason) {
          trace.cancel(reason)
          try {
            await reader.cancel(reason)
          } finally {
            reader.releaseLock()
          }
        },
      })
      return { ...result, stream }
    },
  }
}

export function inspectTarget<T extends ExecutionTarget>(operation: ModelOperation, target: T): T {
  if (target.profile !== 'general' || typeof target.model !== 'object' || target.model === null) return target
  if (inspectedModels.has(target.model)) return target
  const model = wrapLanguageModel({ model: target.model, middleware: inspectorMiddleware(operation, target) })
  inspectedModels.add(model)
  return { ...target, model } as T
}

export async function inspectHttpExchange(
  operation: ModelOperation,
  target: NuExtractRawExecutionTarget,
  request: unknown,
  exchange: () => Promise<Response>,
): Promise<Response> {
  const trace = startTrace(operation, target, request)
  let response: Response
  try {
    response = await exchange()
  } catch (error) {
    trace.fail(error)
    throw error
  }
  try {
    const text = await response.clone().text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* Keep non-JSON provider output verbatim. */ }
    const inspected = { status: response.status, headers: Object.fromEntries(response.headers), body }
    if (response.ok) trace.complete(inspected)
    else trace.fail(inspected)
  } catch (error) {
    trace.fail(error)
  }
  return response
}

export function inspectorResponse(): Response {
  return Response.json({ traces }, { headers: { 'cache-control': 'no-store' } })
}

export function clearInspector(): Response {
  traces.length = 0
  return new Response(null, { status: 204 })
}
