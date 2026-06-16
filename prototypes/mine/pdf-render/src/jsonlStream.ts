// Sealed transport for the backend's JSON Lines streaming endpoints.
// It owns line framing, the event-envelope dispatch loop, and abort wiring;
// it knows the envelope and nothing endpoint-specific. Feature code depends on
// this module via `streamJsonl`, never the reverse.

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000'

// ---------- event envelope (typed view of the {event, data} line protocol) ----------

export type DeltaEvent = { event: 'delta'; data: { think?: string; output?: string; page?: number } }
export type ErrorEvent = { event: 'error'; data: { detail?: string; raw?: string } }
export type PageDoneEvent = {
  event: 'page_done'
  data: { page: number; markdown: string; reasoning: string | null }
}
export type DoneEvent<T> = { event: 'done'; data: T }
export type JsonlEvent<T> = DeltaEvent | ErrorEvent | PageDoneEvent | DoneEvent<T>

// ---------- raw line framing ----------

type RawLine = { event: string; data: Record<string, unknown> }

async function* readJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<RawLine> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })

      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line) {
          yield JSON.parse(line) as RawLine
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }

    const tail = buffer.trim()
    if (tail) {
      yield JSON.parse(tail) as RawLine
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------- the sealed surface ----------

export type StreamHandlers = {
  /** Incremental model output; `page` is present only for the markdown endpoint. */
  onDelta: (output: string, page?: number) => void
  /** Per-page terminal event; only the markdown endpoint emits these. */
  onPageDone?: (page: PageDoneEvent['data']) => void
}

/**
 * POST `endpoint` and consume its JSONL stream. Dispatches `delta` to onDelta,
 * `page_done` to onPageDone, throws on `error`, and resolves with the decoded
 * terminal `done` payload. Throws if the stream closes without a `done` event.
 */
export async function streamJsonl<T>(
  endpoint: string,
  form: FormData,
  handlers: StreamHandlers,
  decodeDone: (data: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/jsonl' },
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `Request to ${endpoint} failed (HTTP ${response.status})`)
  }
  if (!response.body) {
    throw new Error(`Request to ${endpoint} returned no response body`)
  }

  for await (const { event, data } of readJsonLines(response.body)) {
    // Buffered lines from an already-read chunk can still arrive after an abort;
    // the transport owns the contract that no handler fires once aborted.
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if (event === 'delta') {
      const output = typeof data.output === 'string' ? data.output : ''
      if (output) {
        handlers.onDelta(output, typeof data.page === 'number' ? data.page : undefined)
      }
    } else if (event === 'page_done') {
      if (typeof data.page !== 'number' || typeof data.markdown !== 'string') {
        throw new Error(
          `${endpoint}: page_done event missing 'page'/'markdown' — backend contract drift?`,
        )
      }
      // `reasoning` is legitimately null (backend emits None when absent).
      handlers.onPageDone?.({
        page: data.page,
        markdown: data.markdown,
        reasoning: typeof data.reasoning === 'string' ? data.reasoning : null,
      })
    } else if (event === 'error') {
      throw new Error(typeof data.detail === 'string' ? data.detail : 'Model endpoint error')
    } else if (event === 'done') {
      return decodeDone(data)
    }
  }

  throw new Error(`${endpoint}: stream ended without a result`)
}
