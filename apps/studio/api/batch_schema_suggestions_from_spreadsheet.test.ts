import { describe, expect, it, vi } from 'vitest'
import type {
  BatchSchemaSuggestionRecord,
  ProjectSpreadsheetVersionRecord,
  ResearcherProjectStore,
} from 'db'
import { createResearcherApiHandlers } from './batch_schema_suggestions.js'

const runtime = vi.hoisted(() => ({ createResearcherExtractions: vi.fn(() => ({})) }))
vi.mock('./_extraction_runtime.js', () => ({
  createResearcherExtractions: runtime.createResearcherExtractions,
}))
vi.mock('./_project_operations.js', () => ({
  projectOperations: { kick: vi.fn() },
}))

const researcherAccountId = '51000000-0000-4000-8009-000000000001'
const projectContextId = '51000000-0000-4000-8000-000000000001'
const suggestionId = '51000000-0000-4000-8008-000000000001'
const spreadsheetVersionId = '51000000-0000-4000-8010-000000000001'
const now = new Date('2026-09-17T10:00:00.000Z')

function currentSpreadsheet(
  columns: { columnName: string }[],
  overrides: Partial<ProjectSpreadsheetVersionRecord> = {},
): ProjectSpreadsheetVersionRecord {
  return {
    projectSpreadsheetVersionId: spreadsheetVersionId,
    projectContextId,
    revisionNumber: 1,
    originalFilename: 'gold.xlsx',
    columns,
    rows: null,
    exhaustive: true,
    createdAt: now,
    ...overrides,
  }
}

function baseSuggestion(
  overrides: Partial<BatchSchemaSuggestionRecord> = {},
): BatchSchemaSuggestionRecord {
  return {
    batchSchemaSuggestionId: suggestionId,
    projectContextId,
    selectionKey: 'a'.repeat(64),
    attempt: 1,
    executionStatus: 'COMPLETED',
    phase: 'READY',
    sourceKind: 'SPREADSHEET',
    columnFieldMapping: { species: 'species-node-id' },
    projectSpreadsheetVersionId: spreadsheetVersionId,
    proposal: {
      recordDescription: 'Uploaded from a spreadsheet.',
      schemaNodes: [{ id: 'species-node-id', name: 'species', type: 'string' }],
    },
    coverage: null,
    draft: {
      recordDescription: 'Uploaded from a spreadsheet.',
      schemaNodes: [{ id: 'species-node-id', name: 'species', type: 'string' }],
    },
    draftVersion: 0,
    failure: null,
    confirmedSchemaRevisionId: null,
    batchExtractionId: null,
    createdAt: now,
    sources: [],
    ...overrides,
  }
}

function handlerFor(store: Partial<ResearcherProjectStore>) {
  return createResearcherApiHandlers({
    researcherAccountId,
    ...store,
  } as ResearcherProjectStore).POST
}

function createRequest(body: Record<string, unknown>) {
  return new Request('http://test/api/batch-schema-suggestions/from-spreadsheet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/batch-schema-suggestions/from-spreadsheet', () => {
  it('builds a template from the project\'s current spreadsheet and creates a READY suggestion with no sources', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(async () =>
      currentSpreadsheet([
        { columnName: 'species' },
      ]),
    )
    const createSpreadsheetSchemaSuggestion = vi.fn<
      ResearcherProjectStore['createSpreadsheetSchemaSuggestion']
    >(async () => ({
      status: 'created' as const,
      suggestion: baseSuggestion(),
    }))
    const handler = handlerFor({ getCurrentProjectSpreadsheet, createSpreadsheetSchemaSuggestion })

    const response = await handler(createRequest({ projectContextId }))

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.batchSchemaSuggestion.sourceKind).toBe('SPREADSHEET')
    expect(body.batchSchemaSuggestion.phase).toBe('READY')
    expect(body.batchSchemaSuggestion.sources).toEqual([])
    expect(body.batchSchemaSuggestion.projectSpreadsheetVersionId).toBe(spreadsheetVersionId)
    expect(body.batchSchemaSuggestion.columnFieldMapping).toEqual({
      species: 'species-node-id',
    })
    expect(createSpreadsheetSchemaSuggestion).toHaveBeenCalledOnce()
    const [calledProjectContextId, definition, mapping, calledVersionId] =
      createSpreadsheetSchemaSuggestion.mock.calls[0]
    expect(calledProjectContextId).toBe(projectContextId)
    expect(calledVersionId).toBe(spreadsheetVersionId)
    expect((definition as { schemaNodes: { name: string }[] }).schemaNodes.map((node) => node.name)).toEqual([
      'species',
    ])
    expect(Object.keys(mapping)).toEqual(['species'])
  })

  it('splits a dot-separated header into a nested field when a separator is given', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(async () =>
      currentSpreadsheet([
        { columnName: 'measurement.temperature' },
        { columnName: 'measurement.unit' },
      ]),
    )
    const createSpreadsheetSchemaSuggestion = vi.fn<
      ResearcherProjectStore['createSpreadsheetSchemaSuggestion']
    >(async () => ({
      status: 'created' as const,
      suggestion: baseSuggestion(),
    }))
    const handler = handlerFor({ getCurrentProjectSpreadsheet, createSpreadsheetSchemaSuggestion })

    const response = await handler(createRequest({ projectContextId, separator: '.' }))

    expect(response.status).toBe(201)
    const [, definition] = createSpreadsheetSchemaSuggestion.mock.calls[0]
    const schemaNodes = (definition as { schemaNodes: { name: string; type: string; children?: { name: string }[] }[] }).schemaNodes
    const measurement = schemaNodes.find((node) => node.name === 'measurement')!
    expect(measurement.type).toBe('object')
    expect(measurement.children!.map((child) => child.name)).toEqual([
      'temperature',
      'unit',
    ])
  })

  it('rejects a column that is both a leaf and a group prefix, without calling the store', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(async () =>
      currentSpreadsheet([
        { columnName: 'measurement' },
        { columnName: 'measurement.temperature' },
      ]),
    )
    const createSpreadsheetSchemaSuggestion = vi.fn()
    const handler = handlerFor({ getCurrentProjectSpreadsheet, createSpreadsheetSchemaSuggestion })

    const response = await handler(createRequest({ projectContextId, separator: '.' }))

    expect(response.status).toBe(422)
    expect(createSpreadsheetSchemaSuggestion).not.toHaveBeenCalled()
  })

  it('404s when the project has no uploaded spreadsheet yet', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(async () => null)
    const createSpreadsheetSchemaSuggestion = vi.fn()
    const handler = handlerFor({ getCurrentProjectSpreadsheet, createSpreadsheetSchemaSuggestion })

    const response = await handler(createRequest({ projectContextId }))

    expect(response.status).toBe(404)
    expect(createSpreadsheetSchemaSuggestion).not.toHaveBeenCalled()
  })

  it('rejects a request with no projectContextId', async () => {
    const createSpreadsheetSchemaSuggestion = vi.fn()
    const handler = handlerFor({ createSpreadsheetSchemaSuggestion })
    const response = await handler(createRequest({}))
    expect(response.status).toBe(422)
    expect(createSpreadsheetSchemaSuggestion).not.toHaveBeenCalled()
  })

  it('404s when the Project Context is not found (creating the suggestion fails after a spreadsheet is somehow found)', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(async () =>
      currentSpreadsheet([{ columnName: 'species' }]),
    )
    const createSpreadsheetSchemaSuggestion = vi.fn(async () => null)
    const handler = handlerFor({ getCurrentProjectSpreadsheet, createSpreadsheetSchemaSuggestion })

    const response = await handler(createRequest({ projectContextId }))
    expect(response.status).toBe(404)
  })

  it('gives every field a plain string type, since only the header row was read', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(async () =>
      currentSpreadsheet([
        { columnName: 'temperature' },
      ]),
    )
    const createSpreadsheetSchemaSuggestion = vi.fn<
      ResearcherProjectStore['createSpreadsheetSchemaSuggestion']
    >(async () => ({
      status: 'created' as const,
      suggestion: baseSuggestion(),
    }))
    const handler = handlerFor({ getCurrentProjectSpreadsheet, createSpreadsheetSchemaSuggestion })

    const response = await handler(createRequest({ projectContextId }))

    expect(response.status).toBe(201)
    const [, definition] = createSpreadsheetSchemaSuggestion.mock.calls[0]
    expect(
      (definition as { schemaNodes: { name: string; type: string }[] }).schemaNodes,
    ).toEqual([{ id: expect.any(String), name: 'temperature', type: 'string' }])
  })
})
