import { normalizeProviderSettings } from '@/app/lib/provider-settings'
import { runStructuredExtraction } from '@/app/lib/nuextract'

export const maxDuration = 120

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const pages = readPages(form.get('pages'))
    if (pages.length === 0) {
      return Response.json({ detail: 'Provide rasterised source document pages' }, { status: 400 })
    }
    const template = readJson(form.get('template')) ?? {}
    const providerSettings = normalizeProviderSettings(readJson(form.get('provider_settings')))
    const result = await runStructuredExtraction({ pages, template, providerSettings })
    return Response.json(result)
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : 'Extraction failed' }, { status: 502 })
  }
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
