import { createHash } from 'node:crypto'
import { vi } from 'vitest'

const encoder = new TextEncoder()
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

/** One kei page file (kei-exp `pagefile.Page`) with a single native text segment. */
export function keiPage(overrides: Record<string, unknown> = {}) {
  return {
    generation: 'gen-1',
    page: 1,
    size_pt: [612, 792],
    units: [],
    segments: [
      {
        text: 'Unit 7', html: null, markdown: 'Unit 7', label: 'text', confidence: null, status: 'ok', unit: 0,
        crop: null, bbox_px: null, bbox_pt: [36, 36, 100, 54], extent: 'input',
      },
    ],
    markdown: 'Unit 7',
    complete: true,
    warnings: [],
    ...overrides,
  }
}

export type KeiReadRoute = 'result' | 'page'

/**
 * kei's read API (`GET /api/runs/{run}/result` and `/pages/1`) for one published one-page run of `pdf`, as a fetch
 * double. `respond` replaces a route's answer; anything else is kei's 404.
 */
export function keiReadApi(options: {
  pdf: Uint8Array
  runId?: string
  manifest?: Record<string, unknown>
  respond?: (route: KeiReadRoute, fallback: () => Response) => Response | Promise<Response>
}) {
  const runId = options.runId ?? 'run-1'
  const page = encoder.encode(JSON.stringify(keiPage()))
  const manifest = {
    result_version: 5,
    generation: 'gen-1',
    digest: 'digest',
    fingerprint: 'fingerprint',
    recipe: { source_sha256: sha256(options.pdf), transcriber: 'native', model: null, versions: { docling: '2.127.0' } },
    source_name: 'report.pdf',
    page_count: 1,
    effective: {},
    started: '2026-09-22T12:03:13.269538+00:00',
    seconds: 2.5,
    status: 'success',
    incomplete: null,
    pages: { '1': { sha256: sha256(page), complete: true } },
    tokens: { input: 0, output: 0 },
    ...options.manifest,
  }
  const respond = options.respond ?? ((_route: KeiReadRoute, fallback: () => Response) => fallback())
  return vi.fn(async (input: string | URL | Request) => {
    const { pathname } = new URL(String(input))
    if (pathname === `/api/runs/${runId}/result`) return respond('result', () => Response.json(manifest))
    if (pathname === `/api/runs/${runId}/pages/1`)
      return respond('page', () => new Response(page, { headers: { 'content-type': 'application/json' } }))
    return new Response('no such run', { status: 404 })
  })
}
