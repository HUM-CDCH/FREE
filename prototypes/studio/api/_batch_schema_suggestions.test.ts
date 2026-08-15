import { describe, expect, it, vi } from 'vitest'
import {
  modelSuggestedDefinition,
  runSourceSchemaSuggestion,
} from './_batch_schema_suggestions.js'

const PROJECT = '51000000-0000-4000-8000-000000000001'
const DOCUMENT = '51000000-0000-4000-8001-000000000001'
const SUGGESTION = '51000000-0000-4000-8005-000000000001'

describe('batch source Schema Suggestions', () => {
  it('recursively rejects canonical Evidence fields in every model response', () => {
    expect(() =>
      modelSuggestedDefinition({
        _description: 'One record.',
        place: {
          _description: 'One place.',
          fuzzyMatches: 'string',
        },
      }),
    ).toThrow(/reserved Evidence/i)
  })

  it('runs only the durable lease owner and persists a checked template', async () => {
    const store = {
      beginSourceSchemaSuggestion: vi.fn(async (): Promise<
        | {
            status: 'work'
            schemaSuggestionId: string
            descriptor: { artifactReference: string; artifactSha256: string }
          }
        | { status: 'pending' }
      > => ({
        status: 'work' as const,
        schemaSuggestionId: SUGGESTION,
        descriptor: {
          artifactReference: 'a'.repeat(64),
          artifactSha256: 'a'.repeat(64),
        },
      })),
      completeSourceSchemaSuggestion: vi.fn(async () => {}),
      failSourceSchemaSuggestion: vi.fn(async () => {}),
    }
    const generate = vi.fn(async () => ({
      template: { _description: 'One record.', place: 'string' },
      raw: '{"place":"string"}',
      pages: null,
    }))

    await runSourceSchemaSuggestion(store, PROJECT, DOCUMENT, {
      readMarkdown: vi.fn(async () => ({
        bytes: new TextEncoder().encode('Source'),
        mediaType: 'text/markdown',
      })),
      generate: generate as never,
    })

    expect(generate).toHaveBeenCalledOnce()
    expect(store.completeSourceSchemaSuggestion).toHaveBeenCalledWith(
      SUGGESTION,
      { _description: 'One record.', place: 'string' },
      '{"place":"string"}',
    )

    store.beginSourceSchemaSuggestion.mockResolvedValueOnce({ status: 'pending' })
    await runSourceSchemaSuggestion(store, PROJECT, DOCUMENT, {
      generate: generate as never,
    })
    expect(generate).toHaveBeenCalledOnce()
  })
})
