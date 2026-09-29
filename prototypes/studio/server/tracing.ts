import { SpanStatusCode, trace, type Span, type SpanOptions } from '@opentelemetry/api'
import type { SpanExporter } from '@opentelemetry/sdk-trace-node'

/**
 * Developer tracing of model calls to Phoenix (docs/operations/local-development.md). Off unless
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set: then DBOS's workflow and step spans, the AI SDK's model-call spans and
 * each HTTP request under them are exported. Export is batched in the background, so an unreachable collector only
 * drops spans. Prompts, raw responses and parsed outputs are recorded only when FREE_TRACE_CAPTURE lists them
 * (`prompts`, `responses`, `parsed`); request headers, and with them model keys, never are.
 */
export async function startTracing(
  environment: NodeJS.ProcessEnv = process.env,
  exporter?: SpanExporter,
): Promise<boolean> {
  if (!environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return false
  // Loaded only when tracing is on: every API module imports this file.
  const [{ OpenTelemetry }, { OTLPTraceExporter }, { UndiciInstrumentation }, { resourceFromAttributes }, sdk, { registerTelemetry }] =
    await Promise.all([
      import('@ai-sdk/otel'),
      import('@opentelemetry/exporter-trace-otlp-proto'),
      import('@opentelemetry/instrumentation-undici'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/sdk-trace-node'),
      import('ai'),
    ])
  new sdk.NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'studio' }),
    spanProcessors: [new sdk.BatchSpanProcessor(withoutErrorContent(exporter ?? new OTLPTraceExporter()))],
  }).register()
  // One span per request a model call actually sent, AI SDK retries included; only under a traced call.
  new UndiciInstrumentation({ requireParentforSpans: true })
  registerTelemetry(new OpenTelemetry())
  return true
}

/** SDK exception recording bypasses recordInputs/recordOutputs. Provider messages and stacks can quote keys or
 *  source text, so every exporter receives only error types and status codes, regardless of capture settings. */
function withoutErrorContent(exporter: SpanExporter): SpanExporter {
  return {
    export(spans, done) {
      exporter.export(spans.map((span) => ({
        name: span.name,
        kind: span.kind,
        spanContext: () => span.spanContext(),
        parentSpanContext: span.parentSpanContext,
        startTime: span.startTime,
        endTime: span.endTime,
        status: { code: span.status.code },
        attributes: span.attributes,
        links: span.links,
        events: span.events.map((event) => ({
          ...event,
          attributes: event.name === 'exception'
            ? { 'exception.type': event.attributes?.['exception.type'] ?? 'Error' }
            : event.attributes,
        })),
        duration: span.duration,
        ended: span.ended,
        resource: span.resource,
        instrumentationScope: span.instrumentationScope,
        droppedAttributesCount: span.droppedAttributesCount,
        droppedEventsCount: span.droppedEventsCount,
        droppedLinksCount: span.droppedLinksCount,
      })), done)
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
  }
}

export function captures(content: 'prompts' | 'responses' | 'parsed'): boolean {
  return (process.env.FREE_TRACE_CAPTURE ?? '').split(',').includes(content)
}

const tracer = trace.getTracer('studio')

/** Runs `run` in an active span, which records a failure and always ends. */
export function inSpan<T>(name: string, options: SpanOptions, run: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, options, async (span) => {
    try {
      return await run(span)
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error))
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      span.end()
    }
  })
}

/** One logical model call: its provider calls and their fallback nest under this span, and with `parsed` capture it
 *  records what the call's reply was read as. */
export function traceModelCall<T>(
  name: string,
  call: () => Promise<T>,
  parsed: (result: T) => unknown = (result) => result,
): Promise<T> {
  return inSpan(name, { attributes: { 'openinference.span.kind': 'CHAIN' } }, async (span) => {
    const result = await call()
    if (captures('parsed'))
      span.setAttributes({ 'output.value': JSON.stringify(parsed(result)), 'output.mime_type': 'application/json' })
    return result
  })
}
