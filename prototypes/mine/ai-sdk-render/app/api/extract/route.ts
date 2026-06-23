import { normalizeProviderSettings } from '@/app/lib/provider-settings'
import { describeProviderFailure } from '@/app/lib/provider-errors'
import { runStructuredExtraction } from '@/app/lib/nuextract'

export const maxDuration = 120

const MISSING_PAGES_DETAIL = 'Provide rasterised source document pages'

export async function POST(req: Request) {
  if (!isFormRequest(req)) {
    return Response.json({ detail: MISSING_PAGES_DETAIL }, { status: 400 })
  }

  let providerSettings = normalizeProviderSettings(null)

  try {
    const form = await req.formData()
    const pages = readPages(form.get('pages'))
    if (pages.length === 0) {
      return Response.json({ detail: MISSING_PAGES_DETAIL }, { status: 400 })
    }
    const template = readJson(form.get('template')) ?? {}
    providerSettings = normalizeProviderSettings(readJson(form.get('provider_settings')))
    const result = await runStructuredExtraction({ pages, template, providerSettings })
    return Response.json(result)
  } catch (error) {
    return Response.json(
      { detail: describeProviderFailure({ operation: 'Extraction', providerSettings }, error) },
      { status: 502 },
    )
  }
}

function isFormRequest(req: Request) {
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? ''
  return contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')
}

function readPages(value: FormDataEntryValue | null): string[] {
  const parsed = readJson(value)
  if (!Array.isArray(parsed) || !parsed.every((page) => typeof page === 'string')) {
    return []
  }
  return parsed
}

function readJson(value: FormDataEntryValue | null) {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  return JSON.parse(value)
}
