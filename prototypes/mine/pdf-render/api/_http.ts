export class RequestError extends Error {
  readonly status: number
  readonly raw: string | null

  constructor(status: number, message: string, raw: string | null = null) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.raw = raw
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init)
}

export function modelError(error: unknown): Response {
  if (error instanceof RequestError) {
    const detail = error.raw ? { message: error.message, raw: error.raw } : error.message
    return json({ detail }, { status: error.status })
  }

  if (error instanceof Error) {
    return json({ detail: error.message }, { status: 502 })
  }

  return json({ detail: 'Model request failed.' }, { status: 502 })
}

export function parseTemperature(value: FormDataEntryValue | null): number | undefined {
  if (value === null || typeof value !== 'string' || value.trim() === '') {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new RequestError(400, 'temperature must be a number between 0 and 2')
  }
  return parsed
}
