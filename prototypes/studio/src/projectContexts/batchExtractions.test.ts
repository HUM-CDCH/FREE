import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BatchSchemaSuggestionRequestError,
  mergeBatchSchemaSuggestions,
} from './batchExtractions'

afterEach(() => vi.unstubAllGlobals())

describe('batch schema suggestion transport', () => {
  it('preserves safe per-source model failure diagnostics', async () => {
    const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'source_suggestion_failed',
              message: 'Fields could not be suggested.',
              details: {
                failures: [
                  { sourceDocumentId, code: 'invalid_model_output' },
                ],
              },
            },
          },
          { status: 502 },
        ),
      ),
    )

    await expect(
      mergeBatchSchemaSuggestions(
        '51000000-0000-4000-8000-000000000001',
        [sourceDocumentId],
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BatchSchemaSuggestionRequestError>>({
        status: 502,
        failure: expect.objectContaining({
          code: 'source_suggestion_failed',
          details: {
            failures: [
              { sourceDocumentId, code: 'invalid_model_output' },
            ],
          },
        }),
      }),
    )
  })

  it('preserves a top-level invalid Extraction Route classification', async () => {
    const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'invalid_model_config',
              message: 'The Extraction Route is not configured.',
            },
          },
          { status: 409 },
        ),
      ),
    )

    await expect(
      mergeBatchSchemaSuggestions(
        '51000000-0000-4000-8000-000000000001',
        [sourceDocumentId],
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BatchSchemaSuggestionRequestError>>({
        status: 409,
        failure: expect.objectContaining({ code: 'invalid_model_config' }),
      }),
    )
  })

  it('does not trust malformed details as a typed suggestion failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'unexpected_failure',
              message: 'Request failed.',
              details: { arbitrary: true },
            },
          },
          { status: 500 },
        ),
      ),
    )

    const error = await mergeBatchSchemaSuggestions(
      '51000000-0000-4000-8000-000000000001',
      ['51000000-0000-4000-8001-000000000001'],
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(BatchSchemaSuggestionRequestError)
  })
})
