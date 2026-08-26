import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import type {
  ExtractionModelSession,
  ExtractionPersistence,
  TerminalExtraction,
} from './dependencies.js'
import { createExtractionModule } from './module.js'
import type { ExtractionSnapshot } from './types.js'

const metadata = {
  finishReason: 'stop',
  inputTokens: 10,
  outputTokens: 5,
  durationMs: 2,
} as const
const attribution = { provider: 'test', modelId: 'pinned' } as const
const schemaTree = {
  recordDescription: 'Article records.',
  schemaNodes: [
    { id: 'title', name: 'title', type: 'string' },
    { id: 'year', name: 'year', type: 'integer' },
  ],
}

function snapshot(terminal: TerminalExtraction): ExtractionSnapshot {
  return {
    ...terminal,
    extractionSchemaId: randomUUID(),
    sourceRepresentationRevisionNumber: 1,
    schemaRevisionNumber: 1,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    reviewedAt: null,
    reviewDecisions: [],
  }
}

function harness(
  records: readonly Record<string, unknown>[],
  selections: (claimLabels: readonly string[], anchorLabels: readonly string[]) =>
    readonly { claimLabel: string; anchorLabel: string | null }[] =
    (claimLabels, anchorLabels) =>
      claimLabels.map((claimLabel, index) => ({
        claimLabel,
        anchorLabel: anchorLabels[index] ?? anchorLabels[0] ?? null,
      })),
) {
  let opened = 0
  let persisted: TerminalExtraction | null = null
  const session: ExtractionModelSession = {
    attribution,
    model: {
      async extract() {
        return { result: { records }, metadata }
      },
    },
    groundingModel: {
      async ground(request) {
        return {
          selections: selections(
            Object.keys(request.claims),
            Object.keys(request.anchors),
          ),
          metadata,
        }
      },
    },
  }
  const persistence = {
    async readExtraction() {
      return null
    },
    async isExtractionIdAvailable() {
      return true
    },
    async loadExtractionInputs(
      sourceRepresentationRevisionId: string,
      schemaRevisionId: string,
    ) {
      return {
        sourceDocumentId: randomUUID(),
        projectContextId: randomUUID(),
        sourceRepresentationRevisionId,
        schemaRevisionId,
        schemaTree,
        parsedDocument,
      }
    },
    async persistExtraction(terminal: TerminalExtraction) {
      persisted = terminal
      return { status: 'created' as const, extraction: snapshot(terminal) }
    },
  } as unknown as ExtractionPersistence
  const module = createExtractionModule({
    persistence,
    models: {
      async open() {
        opened += 1
        return session
      },
    },
    now: () => 10,
  })
  return {
    module,
    opened: () => opened,
    persisted: () => persisted,
  }
}

function input() {
  return {
    kind: 'fresh' as const,
    extractionId: randomUUID(),
    sourceRepresentationRevisionId: randomUUID(),
    schemaRevisionId: randomUUID(),
    strategy: 'ARTICLE' as const,
  }
}

describe('ExtractionModule Article contract', () => {
  it('retains valid zero- and multi-record Article results', async () => {
    const empty = harness([])
    assert.deepEqual((await empty.module.runSingle(input())).extraction.result, {
      records: [],
    })

    const multiple = harness([
      { title: 'Alpha', year: 1901 },
      { title: 'Beta', year: 1902 },
    ])
    const result = await multiple.module.runSingle(input())
    assert.deepEqual(result.extraction.result, {
      records: [
        { title: 'Alpha', year: 1901 },
        { title: 'Beta', year: 1902 },
      ],
    })
    assert.equal(multiple.opened(), 1)
    assert.equal(result.extraction.diagnostics.groundingBatches.length, 2)
  })

  it('keeps a partially grounded result reviewable and incomplete', async () => {
    const partial = harness(
      [{ title: 'Alpha', year: 1901 }],
      (claimLabels, anchorLabels) => [
        { claimLabel: claimLabels[0]!, anchorLabel: anchorLabels[0] ?? null },
      ],
    )
    const result = await partial.module.runSingle(input())
    assert.equal(result.extraction.outcome, 'SUCCEEDED')
    assert.equal(result.extraction.reviewable, true)
    assert.equal(result.extraction.complete, false)
    assert.equal(result.extraction.diagnostics.ungroundedPaths.length, 1)
    assert.equal(partial.persisted()?.modelAttribution, attribution)
  })
})
