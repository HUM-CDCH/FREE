import { describe, it, expect, vi, afterEach } from 'vitest'
import ExcelJS from 'exceljs'
import type { SchemaNode } from 'extraction/schema'
import { downloadDurableExport, durableBatchExportBlob, durableExportBlob, durableExportTables, fixedDurableValues, type Fixed } from './durableExport'

vi.mock('./auth/authenticatedFetch', () => ({ authenticatedFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>) }))
afterEach(() => vi.unstubAllGlobals())

type Value = Fixed['page']['values'][number]
const title: SchemaNode = { id: 'title', name: 'title', type: 'string' }
const site: SchemaNode = { id: 'site', name: 'site', type: 'string' }
const year: SchemaNode = { id: 'year', name: 'year', type: 'integer' }
const gilded: SchemaNode = { id: 'gilded', name: 'gilded', type: 'boolean' }
const names: SchemaNode = { id: 'names', name: 'names', type: 'array', itemType: 'string' }
const finds: SchemaNode = { id: 'finds', name: 'finds', type: 'array', children: [{ id: 'name', name: 'name', type: 'string' }, { id: 'count', name: 'count', type: 'integer' }] }
const catalogue: SchemaNode = { id: 'catalogue', name: 'catalogue', type: 'string', valueSource: 'document' }

function value(record: number, node: SchemaNode, modelValue: unknown, extra: Record<string, unknown> = {}): Value {
  return { id: `record-${record}:${node.id}`, recordId: `record-${record}`, fieldId: node.id, path: ['records', record, node.name], selectionId: 'used',
    schemaRevisionId: 'historical', node, modelValue, evidence: [], links: [], grounding: 'ungrounded', processing: 'saved', lineage: [],
    correction: null, historicalCorrection: null, ...extra } as unknown as Value
}
const decided = (action: string, decided?: unknown) => ({ correction: { revision: 1, decision: { action, ...(decided === undefined ? {} : { value: decided }), evidence: [], included: true } } })
const values: Value[] = [
  value(0, title, 'Grave 8', decided('EDITED', 'Corrected 8')), value(0, site, '=1+1'), value(0, year, 0), value(0, gilded, false),
  value(0, names, ['Ada', 'Bob']), value(0, finds, [{ name: 'Nadel', count: 2 }, { name: 'Ring', count: 1 }]),
  value(1, title, '第3号'), value(1, site, 'Jade', decided('APPROVED')), value(1, year, 1902, decided('REJECTED')), value(1, gilded, true),
  value(1, names, []), value(1, finds, null),
  { ...value(0, catalogue, 'Fundkatalog Süd'), id: 'catalogue', recordId: 'document' },
]
const fixed = {
  state: { extractionId: 'extraction', strategy: 'CATALOG', sourceRevisionId: 'source', status: 'PAUSED', snapshotVersion: 1, feedbackVersion: 2,
    selection: { id: 'used', ordinal: 1, schemaRevisionId: 'historical', schemaTree: { schemaNodes: [title, site, year, gilded, names, finds, catalogue] } }, source: { generation: 'g1' } },
  page: { snapshotVersion: 1, feedbackVersion: 2, status: 'PAUSED', finalization: null, coverage: { incomplete: true },
    reviewCounts: { required: 12, toCheck: 9, approved: 1, edited: 1, rejected: 1 }, values, total: values.length, next: null },
} as unknown as Fixed
const root = { rowsRepresent: '$', otherRepeatedFields: 'preserve' as const }

async function workbook(blob: Blob) {
  expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(await blob.arrayBuffer())
  return book
}
function cells(sheet: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = []
  sheet.eachRow((row) => rows.push(Array.from({ length: sheet.columnCount }, (_, index) => row.getCell(index + 1).value ?? null)))
  return rows
}
/** A browser double for the download path: records what would be saved. */
function stubDownloads() {
  const downloads: { blob: Blob; filename: string }[] = [], blobs = new Map<string, Blob>()
  vi.stubGlobal('document', { body: { append: () => undefined }, createElement: () => ({ href: '', download: '', hidden: false, remove: () => undefined,
    click(this: { href: string; download: string }) { downloads.push({ blob: blobs.get(this.href)!, filename: this.download }) } }) })
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (blob: Blob) => { const url = `blob:${blobs.size}`; blobs.set(url, blob); return url }, revokeObjectURL: () => undefined }))
  return downloads
}

describe('durable exports', () => {
  it('writes schema-ordered columns when values were saved in a different order', async () => {
    const shuffled = [values[3]!, values[2]!, values[0]!];
    const csv = await durableExportBlob(fixed, shuffled, 'csv', root, 'Beretning.pdf');
    expect(await csv.text()).toBe('title,year,gilded\r\nCorrected 8,0,false');
  })
  it('writes the ordinary research table: schema fields as columns, one record per row, decisions applied', async () => {
    const book = await workbook(await durableExportBlob(fixed, values, 'xlsx', root, 'Beretning.pdf'))
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['Results', 'Extraction', 'Evidence'])
    expect(cells(book.getWorksheet('Results')!)).toEqual([
      ['title', 'site', 'year', 'gilded', 'names', 'finds.0.name', 'finds.0.count', 'finds.1.name', 'finds.1.count', 'catalogue'],
      ['Corrected 8', "'=1+1", 0, false, 'Ada, Bob', 'Nadel', 2, 'Ring', 1, 'Fundkatalog Süd'],
      // A rejected value, an empty list and a missing composite are all empty cells.
      ['第3号', 'Jade', null, true, null, null, null, null, null, 'Fundkatalog Süd'],
    ])
    const extraction = cells(book.getWorksheet('Extraction')!)
    expect(extraction[0]).toEqual(['Item', 'Value'])
    expect(extraction).toContainEqual(['Source Document', 'Beretning.pdf'])
    expect(extraction).toContainEqual(['Results version', 1])
    expect(extraction).toContainEqual(['Decisions version', 2])
    expect(extraction).toContainEqual(['Producing Schema Revision IDs', 'historical'])
    expect(extraction).toContainEqual(['Records', 2])
    const evidence = cells(book.getWorksheet('Evidence')!)
    expect(evidence[0]).toEqual(['Record', 'Field', 'Extracted value', 'Decision', 'Reviewed value', 'Evidence', 'Evidence anchors', 'Schema revision', 'Note'])
    expect(evidence[1]).toEqual([1, 'title', 'Grave 8', 'Edited', 'Corrected 8', 'No Evidence linked', null, 'historical', null])
    expect(evidence[9]).toEqual([2, 'year', 1902, 'Rejected', null, 'No Evidence linked', null, 'historical', null])
    expect(evidence[13]).toEqual(['Document', 'catalogue', 'Fundkatalog Süd', 'To check', null, 'No Evidence linked', null, 'historical', null])
  })

  it('writes a plain CSV file of the same table, with the repeated objects as the chosen rows', async () => {
    const csv = await durableExportBlob(fixed, values, 'csv', { rowsRepresent: 'finds', otherRepeatedFields: 'omit' }, 'Beretning.pdf')
    expect(csv.type).toBe('text/csv;charset=utf-8')
    expect(await csv.text()).toBe([
      'title,site,year,gilded,names,finds.name,finds.count,catalogue',
      "Corrected 8,'=1+1,0,false,\"Ada, Bob\",Nadel,2,Fundkatalog Süd",
      "Corrected 8,'=1+1,0,false,\"Ada, Bob\",Ring,1,Fundkatalog Süd",
    ].join('\r\n'))
    expect(durableExportTables(fixed, values, root, 'Beretning.pdf').results.rows[0]!.gilded).toBe(false)
  })

  it('exports from the open page without any request, and reads only value pages when the page is partial', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      const next = urls.length === 1 ? { snapshotVersion: 1, feedbackVersion: 2, offset: 500, limit: 500 } : null
      return Response.json({ ...fixed.page, values: urls.length === 1 ? values.slice(0, 6) : values.slice(6), next })
    }))
    expect(await fixedDurableValues(fixed)).toBe(values)
    expect(urls).toEqual([])
    const partial = { ...fixed, page: { ...fixed.page, values: values.slice(0, 1) } } as Fixed
    expect(await fixedDurableValues(partial)).toEqual(values)
    expect(urls).toHaveLength(2)
    expect(urls.every((url) => url.includes('/values?') && url.includes('snapshotVersion=1') && url.includes('feedbackVersion=2'))).toBe(true)
    expect(urls.some((url) => url.includes('/history'))).toBe(false)
  })

  it('exports a long run (hundreds of saved versions, a thousand values) from its shown results alone', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetch)
    const fields = [title, site, year, gilded, names]
    const many = Array.from({ length: 205 }, (_, record) => fields.map((node) => value(record, node, node.type === 'integer' ? record : node.type === 'boolean' ? record % 2 === 0 : node.type === 'array' ? [`n${record}`] : `${node.name} ${record}`))).flat()
    const long = { state: { ...fixed.state, snapshotVersion: 411, feedbackVersion: 1, status: 'COMPLETED' },
      page: { ...fixed.page, snapshotVersion: 411, feedbackVersion: 1, status: 'COMPLETED', values: many, total: many.length } } as unknown as Fixed
    const downloads = stubDownloads()
    await downloadDurableExport(long, 'xlsx', root, 'Beretning_Ellekilde_8_13.pdf')
    expect(fetch).not.toHaveBeenCalled()
    expect(downloads.map((download) => download.filename)).toEqual(['Beretning_Ellekilde_8_13-extraction-result-s411.xlsx'])
    const results = (await workbook(downloads[0]!.blob)).getWorksheet('Results')!
    expect(results.rowCount).toBe(206)
    expect(cells(results)[0]).toEqual(['title', 'site', 'year', 'gilded', 'names'])
    expect(cells(results)[205]).toEqual(['title 204', 'site 204', 204, true, 'n204'])
  })

  it('names the CSV after the source and the results version', async () => {
    const downloads = stubDownloads()
    await downloadDurableExport(fixed, 'csv', root, 'C:\\uploads\\Beretning.pdf')
    expect(downloads[0]!.filename).toBe('Beretning-extraction-result-s1.csv')
    expect(downloads[0]!.blob.type).toBe('text/csv;charset=utf-8')
  })

  it('exports a batch as one table with each row named by its Source Document, members at their own versions', async () => {
    const members = [
      { extractionId: 'extraction', sourceDocumentId: 'one', sourceDocumentName: 'first.pdf', sourceRevisionId: 'source', status: 'PAUSED' },
      { extractionId: 'second', sourceDocumentId: 'two', sourceDocumentName: 'second.pdf', sourceRevisionId: 'second-source', status: 'FAILED' },
      { extractionId: 'pending', sourceDocumentId: 'three', sourceDocumentName: 'third.pdf', sourceRevisionId: 'pending-source', status: 'QUEUED' },
    ]
    const yearAsText: SchemaNode = { id: 'year', name: 'year', type: 'string' }
    const second = { ...fixed, state: { ...fixed.state, extractionId: 'second', sourceRevisionId: 'second-source' },
      page: { ...fixed.page, snapshotVersion: 4, feedbackVersion: 9, status: 'FAILED', finalization: { id: 'f' } } } as Fixed
    const secondValues = [value(0, title, 'Second'), { ...value(0, yearAsText, 'c. 1902'), schemaRevisionId: 'later' }]
    const snapshots = [{ fixed, values: fixed.page.values, member: members[0]! }, { fixed: second, values: secondValues, member: members[1]! }]
    const book = await workbook(await durableBatchExportBlob({ batchExtractionId: 'batch' }, members, snapshots, 'xlsx', root))
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['Results', 'Members', 'Evidence'])
    const results = cells(book.getWorksheet('Results')!)
    expect(results[0]).toEqual(['Source Document', 'Source Document ID', 'Batch Extraction ID', 'title', 'site', 'year', 'gilded', 'names', 'finds.0.name', 'finds.0.count', 'finds.1.name', 'finds.1.count', 'catalogue', 'year (string)'])
    expect(results.slice(1).map((row) => [row[0], row[1], row[3], row[5], row[13]])).toEqual([
      ['first.pdf', 'one', 'Corrected 8', 0, null], ['first.pdf', 'one', '第3号', null, null], ['second.pdf', 'two', 'Second', null, 'c. 1902'],
    ])
    expect(cells(book.getWorksheet('Members')!)).toEqual([
      ['Source Document', 'Source Document ID', 'Extraction ID', 'State', 'Results version', 'Decisions version', 'Review saved', 'Values', 'Source Representation Revision ID'],
      ['first.pdf', 'one', 'extraction', 'Paused', 1, 2, 'Not saved', 13, 'source'],
      ['second.pdf', 'two', 'second', 'Failed', 4, 9, 'Yes', 2, 'second-source'],
      ['third.pdf', 'three', 'pending', 'Queued', null, null, null, null, 'pending-source'],
    ])
    expect(cells(book.getWorksheet('Evidence')!)[0]![0]).toBe('Source Document')
    const csv = await durableBatchExportBlob({ batchExtractionId: 'batch' }, members, snapshots, 'csv', root)
    expect(csv.type).toBe('text/csv;charset=utf-8')
    expect((await csv.text()).split('\r\n')[0]).toBe('Source Document,Source Document ID,Batch Extraction ID,title,site,year,gilded,names,finds.0.name,finds.0.count,finds.1.name,finds.1.count,catalogue,year (string)')
  })
})
