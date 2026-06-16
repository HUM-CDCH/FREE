const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000'

type JsonLineEvent = {
  event: string
  data: Record<string, unknown>
}

async function* readJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonLineEvent> {
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
          yield JSON.parse(line) as JsonLineEvent
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }

    const tail = buffer.trim()
    if (tail) {
      yield JSON.parse(tail) as JsonLineEvent
    }
  } finally {
    reader.releaseLock()
  }
}

export type TemplateAnnotation = { text: string; pageNumber: number }

export type AnnotationsMode = 'hints' | 'fields'

type TemplateOptions = {
  annotations?: TemplateAnnotation[]
  annotationsMode?: AnnotationsMode
}

/**
 * Call the backend's /generate-template endpoint and stream its JSONL events.
 * Delta events carry incremental model output; the terminal done event carries
 * the parsed extraction template, which is this function's return value.
 */
export async function requestTemplate(
  file: Blob,
  fileName: string,
  onDelta: (output: string) => void,
  signal?: AbortSignal,
  options?: TemplateOptions,
): Promise<unknown> {
  const form = new FormData()
  form.append('file', file, fileName)
  if (options?.annotations?.length) {
    form.append('annotations', JSON.stringify(options.annotations))
    form.append('annotations_mode', options.annotationsMode ?? 'hints')
  }

  const response = await fetch(`${API_BASE}/generate-template`, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/jsonl' },
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `Template request failed (HTTP ${response.status})`)
  }
  if (!response.body) {
    throw new Error('Template request returned no response body')
  }

  for await (const { event, data } of readJsonLines(response.body)) {
    if (event === 'delta') {
      const output = typeof data.output === 'string' ? data.output : ''
      if (output) {
        onDelta(output)
      }
    } else if (event === 'error') {
      throw new Error(typeof data.detail === 'string' ? data.detail : 'Model endpoint error')
    } else if (event === 'done') {
      return data.template
    }
  }

  throw new Error('Template stream ended without a result')
}

export type DocumentRecord = {
  doc_hash: string
  filename: string
  page_count: number
  has_text_layer: boolean
}

export async function prepareDocument(file: File): Promise<DocumentRecord> {
  const form = new FormData()
  form.append('file', file, file.name)
  const response = await fetch(`${API_BASE}/documents/prepare`, { method: 'POST', body: form })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `Document prepare failed (HTTP ${response.status})`)
  }
  return response.json() as Promise<DocumentRecord>
}

export type ExtractionResult = {
  result: unknown
  reasoning: string | null
}

export async function extractSelection(
  docHash: string,
  selection: string,
  pageNumber: number,
  template?: unknown,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const form = new FormData()
  form.append('doc_hash', docHash)
  form.append('selection', selection)
  form.append('page_number', String(pageNumber))
  if (template != null) {
    form.append('template', JSON.stringify(template))
  }

  const response = await fetch(`${API_BASE}/extract-selection`, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/jsonl' },
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `Extraction failed (HTTP ${response.status})`)
  }
  if (!response.body) throw new Error('No response body')

  for await (const { event, data } of readJsonLines(response.body)) {
    if (event === 'error') throw new Error(typeof data.detail === 'string' ? data.detail : 'Extraction error')
    if (event === 'done') {
      return {
        result: data.result,
        reasoning: typeof data.reasoning === 'string' ? data.reasoning : null,
      }
    }
  }
  throw new Error('Extraction stream ended without a result')
}
