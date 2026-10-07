import ExcelJS from 'exceljs'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectSpreadsheetVersionRecord, ResearcherProjectStore } from 'db'
import { createResearcherApiHandlers } from './project_spreadsheets.js'

const researcherAccountId = '51000000-0000-4000-8009-000000000001'
const projectContextId = '51000000-0000-4000-8000-000000000001'
const now = new Date('2026-09-17T10:00:00.000Z')

function handlerFor(store: Partial<ResearcherProjectStore>) {
  return createResearcherApiHandlers({
    researcherAccountId,
    ...store,
  } as ResearcherProjectStore)
}

async function spreadsheetFile(rows: unknown[][]): Promise<File> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  for (const row of rows) sheet.addRow(row)
  const buffer = await workbook.xlsx.writeBuffer()
  return new File([buffer as ArrayBuffer], 'gold.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

function uploadRequest(file: File, projectContextIdValue: string = projectContextId) {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('projectContextId', projectContextIdValue)
  return new Request('http://test/api/project-spreadsheets', { method: 'POST', body: form })
}

describe('POST /api/project-spreadsheets', () => {
  it('parses the upload and appends a new version', async () => {
    const appendProjectSpreadsheetVersion = vi.fn(
      async (
        _projectContextId: string,
        originalFilename: string,
        columns: unknown,
      ): Promise<ProjectSpreadsheetVersionRecord> => ({
        projectSpreadsheetVersionId: '51000000-0000-4000-8010-000000000001',
        projectContextId,
        revisionNumber: 1,
        originalFilename,
        columns,
        rows: [],
        exhaustive: true,
        createdAt: now,
      }),
    )
    const handler = handlerFor({ appendProjectSpreadsheetVersion })
    const file = await spreadsheetFile([['species'], ['Salmon'], ['Cod']])

    const response = await handler.POST(uploadRequest(file))

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.projectSpreadsheetVersion.revisionNumber).toBe(1)
    expect(body.projectSpreadsheetVersion.originalFilename).toBe('gold.xlsx')
    expect(body.projectSpreadsheetVersion.columns).toEqual([
      { columnName: 'species' },
    ])
    expect(appendProjectSpreadsheetVersion).toHaveBeenCalledWith(
      projectContextId,
      'gold.xlsx',
      [{ columnName: 'species' }],
      [{ species: 'Salmon' }, { species: 'Cod' }],
    )
  })

  it('rejects a request with no file', async () => {
    const appendProjectSpreadsheetVersion = vi.fn()
    const handler = handlerFor({ appendProjectSpreadsheetVersion })
    const form = new FormData()
    form.append('projectContextId', projectContextId)
    const response = await handler.POST(
      new Request('http://test/api/project-spreadsheets', { method: 'POST', body: form }),
    )
    expect(response.status).toBe(400)
    expect(appendProjectSpreadsheetVersion).not.toHaveBeenCalled()
  })

  it('404s when the Project Context is not found', async () => {
    const appendProjectSpreadsheetVersion = vi.fn(async () => null)
    const handler = handlerFor({ appendProjectSpreadsheetVersion })
    const file = await spreadsheetFile([['species'], ['Salmon']])
    const response = await handler.POST(uploadRequest(file))
    expect(response.status).toBe(404)
  })
})

describe('GET /api/project-spreadsheets', () => {
  it('returns null when no spreadsheet has been uploaded yet', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(async () => null)
    const handler = handlerFor({ getCurrentProjectSpreadsheet })
    const response = await handler.GET(
      new Request(`http://test/api/project-spreadsheets?projectContextId=${projectContextId}`),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ projectSpreadsheetVersion: null })
  })

  it('returns the current version, dropping cell values a pre-existing version stored', async () => {
    const getCurrentProjectSpreadsheet = vi.fn(
      async (): Promise<ProjectSpreadsheetVersionRecord> => ({
        projectSpreadsheetVersionId: '51000000-0000-4000-8010-000000000001',
        projectContextId,
        revisionNumber: 2,
        originalFilename: 'gold-v2.xlsx',
        columns: [{ columnName: 'species', values: ['Trout'] }],
        rows: null,
        exhaustive: true,
        createdAt: now,
      }),
    )
    const handler = handlerFor({ getCurrentProjectSpreadsheet })
    const response = await handler.GET(
      new Request(`http://test/api/project-spreadsheets?projectContextId=${projectContextId}`),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.projectSpreadsheetVersion.revisionNumber).toBe(2)
    expect(body.projectSpreadsheetVersion.originalFilename).toBe('gold-v2.xlsx')
    expect(body.projectSpreadsheetVersion.columns).toEqual([{ columnName: 'species' }])
  })

  it('rejects a missing projectContextId', async () => {
    const handler = handlerFor({})
    const response = await handler.GET(new Request('http://test/api/project-spreadsheets'))
    expect(response.status).toBe(422)
  })
})
