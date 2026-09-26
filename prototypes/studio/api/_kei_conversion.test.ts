import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { ApiError } from './_http.js'
import { keiPage, keiReadApi as keiRun } from '../test/support/keiReadApi.js'
import { conversionFailure, packageConversion } from './_kei_conversion.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const PDF = encoder.encode('%PDF-1.7\n')
const PDF_SHA256 = sha256(PDF)

const keiReadApi = (options: Omit<Parameters<typeof keiRun>[0], 'pdf'> = {}) => keiRun({ pdf: PDF, ...options })

function packageStore() {
  return {
    save: vi.fn(async () => ({
      artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64), document: {}, manifest: {} as never, published: true,
    })),
    available: vi.fn(async () => true),
    read: vi.fn(),
  }
}

function convert(fetcher: ReturnType<typeof keiReadApi>, overrides: Partial<Parameters<typeof packageConversion>[0]> = {}) {
  return packageConversion({
    readBase: 'http://kei.test/',
    runId: 'run-1',
    generation: 'gen-1',
    pdf: PDF,
    originalName: 'report.pdf',
    fetcher,
    packageStore: packageStore(),
    now: () => new Date('2026-09-22T13:00:00Z'),
    ...overrides,
  })
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('packageConversion', () => {
  it('packages the translated document with the upload itself and names its provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-kei-conversion-'))
    try {
      const store = createCanonicalPackageStore(root)
      const fetcher = keiReadApi()
      const converted = await convert(fetcher, { packageStore: store })

      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        'http://kei.test/api/runs/run-1/result',
        'http://kei.test/api/runs/run-1/pages/1',
      ])
      expect(converted).toMatchObject({
        provenance: { contractVersion: 'parsed_document.v2', preprocessId: 'kei-exp:run-1:gen-1', parserName: 'kei-exp', parserVersion: 'docling 2.127.0' },
        pageCount: 1,
        published: true,
      })
      expect(Object.keys(converted.descriptor).sort()).toEqual(['artifactReference', 'artifactSha256'])
      expect(decoder.decode((await store.read(converted.descriptor, 'pdf')).bytes)).toBe('%PDF-1.7\n')
      expect(decoder.decode((await store.read(converted.descriptor, 'markdown')).bytes)).toBe('Grav 8\n')
      const document = decodeParsedDocument(JSON.parse(decoder.decode((await store.read(converted.descriptor, 'source')).bytes)))
      expect(document.document).toMatchObject({
        document_id: 'run-1',
        content_sha256: PDF_SHA256,
        created_at: '2026-09-22T13:00:00.000Z',
        source: { original_filename: 'report.pdf', byte_size: 9 },
      })
      expect(document.evidence_index.anchors[0]!.producer_observations[0]!.producer_ref).toBe('kei-exp:native:page-1')
      // The same conversion packs to the same bytes: a second save publishes nothing new.
      expect((await convert(keiReadApi(), { packageStore: store })).published).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a manifest of another generation than kei reported, before reading a page', async () => {
    const fetcher = keiReadApi({ manifest: { generation: 'gen-2' } })
    const error = await refusal(convert(fetcher))
    expect(error).toMatchObject({
      status: 502, code: 'source_ingestion_failed',
      message: 'The Parsing Service published another parse than the one it reported.',
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('refuses a result of other bytes, a partial result and a page that fails its proof', async () => {
    const foreign = await refusal(convert(keiReadApi({
      manifest: { recipe: { source_sha256: '0'.repeat(64), transcriber: 'native', model: null, versions: {} } },
    })))
    expect(foreign).toMatchObject({ status: 502, message: 'The parsed Source Document could not be translated.' })

    const partialApi = keiReadApi({ manifest: { status: 'incomplete', incomplete: 'page 1 stopped at its token cap' } })
    const partial = await refusal(convert(partialApi))
    expect(partial).toMatchObject({ status: 422, code: 'source_ingestion_failed', message: 'The Source Document was only partially parsed.' })
    expect(partialApi).toHaveBeenCalledOnce()

    const tampered = await refusal(convert(keiReadApi({
      respond: (route, fallback) => (route === 'page' ? Response.json({ ...keiPage(), segments: [] }) : fallback()),
    })))
    expect(tampered).toMatchObject({ status: 502, message: 'The Parsing Service returned an invalid result.' })
  })

  it('maps a refused read to stable public copy, and marks an unavailable read API transient', async () => {
    for (const route of ['result', 'page'] as const) {
      const missing = await refusal(convert(keiReadApi({
        respond: (current, fallback) => (current === route ? new Response('secret', { status: 404 }) : fallback()),
      })))
      expect(missing).toMatchObject({ status: 502, message: 'The parsed Source Document could not be retrieved.' })
      expect(JSON.stringify(missing)).not.toContain('secret')
      expect((missing as ApiError & { transient?: boolean }).transient).not.toBe(true)

      const restarting = await refusal(convert(keiReadApi({
        respond: (current, fallback) => (current === route ? new Response('bad gateway', { status: 502 }) : fallback()),
      })))
      expect((restarting as ApiError & { transient?: boolean }).transient).toBe(true)

      const unreachable = await refusal(convert(keiReadApi({
        respond: (current, fallback) => (current === route ? Promise.reject(new TypeError('fetch failed')) : fallback()),
      })))
      expect(unreachable).toMatchObject({ status: 502, message: 'The Parsing Service is unavailable.' })
      expect((unreachable as ApiError & { transient?: boolean }).transient).toBe(true)
    }
  })

  it('reads nothing once its signal is aborted', async () => {
    const fetcher = keiReadApi()
    const controller = new AbortController()
    controller.abort(new Error('the workflow was cancelled'))
    await expect(convert(fetcher, { signal: controller.signal })).rejects.toThrow('the workflow was cancelled')
  })

  it('maps a package that cannot be saved to source_artifact_unavailable', async () => {
    const store = packageStore()
    store.save.mockRejectedValueOnce(new Error('disk full'))
    const error = await refusal(convert(keiReadApi(), { packageStore: store }))
    expect(error).toMatchObject({
      status: 502, code: 'source_artifact_unavailable', message: 'The parsed Source Document could not be packaged.',
    })
  })
})

describe('conversionFailure', () => {
  it("answers kei's deadline as 504 and every other failure as 422 with kei's reason", () => {
    expect(conversionFailure({ ok: false, code: 'deadline_exceeded', reason: 'stopped at its deadline', retryable: false })).toEqual({
      status: 504, code: 'source_ingestion_timeout', message: 'Source Document parsing did not finish within its time limit.',
    })
    expect(conversionFailure({ ok: false, code: 'source_unreadable', reason: 'PDFium could not open it', retryable: false })).toEqual({
      status: 422, code: 'source_ingestion_failed', message: 'The Source Document could not be parsed: PDFium could not open it',
    })
    const long = conversionFailure({ ok: false, code: 'conversion_failed', reason: 'x'.repeat(600), retryable: false })
    expect(long.message).toHaveLength(512)
  })
})
