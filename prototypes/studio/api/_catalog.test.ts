import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  catalogFingerprint,
  extractCatalog,
  inferPrimaryRepeatedArray,
  mergeCatalogOutputs,
  metadataForItemPrefix,
  resolveCatalogBoundaries,
  sliceCatalogSections,
  type ExtractionSchemaEnvelope,
} from './_catalog.js'

function fixture<T>(name: string): T {
  const text = readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8')
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`Invalid JSON test fixture: ${name}`, { cause: error })
  }
}

const burial = fixture<ExtractionSchemaEnvelope>('Burial_Finds.json')
const markdown = readFileSync(new URL('./test-fixtures/catalog-two-records.md', import.meta.url), 'utf8')
const boundaries = fixture<Record<string, unknown>>('catalog-boundaries.json')
const records = fixture<Record<string, unknown>[]>('catalog-records.json')

describe('Catalog pinned pure behavior', () => {
  it('selects Burial Finds record.entries and its matching metadata', () => {
    expect(inferPrimaryRepeatedArray(burial.record, burial._schema_metadata)?.key).toBe('entries')
    expect(Object.keys(metadataForItemPrefix(burial._schema_metadata, 'entries'))).toContain(
      'record.entries[].fundliste',
    )
  })

  it('prefers richer metadata and preserves declaration order for ties', () => {
    const record = { first: [{ id: '' }], second: [{ id: '' }] }
    expect(
      inferPrimaryRepeatedArray(record, {
        'record.first': { instance_description: 'short' },
        'record.second': { instance_description: 'a much richer description' },
      })?.key,
    ).toBe('second')
    expect(inferPrimaryRepeatedArray(record, {})?.key).toBe('first')
  })

  it('resolves and slices boundaries in source order', () => {
    const resolved = resolveCatalogBoundaries(markdown, boundaries)
    const sections = sliceCatalogSections(markdown, resolved)

    expect(sections.map((section) => section.recordId)).toEqual(['8', '13'])
    expect(sections[0]?.text).toContain('# Grav 8')
    expect(sections[0]?.text).not.toContain('# Grav 13')
    expect(sections[1]?.text).toContain('# Grav 13')
  })

  it('coerces scalar boundary markers like the pinned Python parser', () => {
    const resolved = resolveCatalogBoundaries('123 body', {
      records: [{ record_id: 123, label: 123, start_marker: 123 }],
    })
    expect(resolved).toEqual([expect.objectContaining({ recordId: '123', label: '123', startIndex: 0 })])
  })

  it('drops unresolved markers while slicing remaining records in source order', () => {
    const partial = {
      records: [
        ...(boundaries.records as unknown[]),
        { record_id: 'missing', start_marker: '# Missing', end_marker: '' },
      ],
    }
    const resolved = resolveCatalogBoundaries(markdown, partial)
    expect(resolved.map((item) => item.recordId)).toEqual(['8', '13'])
  })

  it('merges in order and applies scalar fingerprint deduplication', () => {
    const merged = mergeCatalogOutputs([...records, records[0]!], burial, 'entries')
    const entries = merged.entries as Array<Record<string, unknown>>

    expect(entries.map((entry) => entry.Grav_id)).toEqual(['8', '13'])
    const firstFind = (entries[0]?.fundliste as Array<Record<string, unknown>>)[0]
    expect(firstFind).toEqual(
      expect.objectContaining({
        Fund_no: '8-2',
        Fund_beskrivelse: 'Jernspænde',
      }),
    )
    expect((firstFind?._evidence as Record<string, unknown>).Fund_no).toEqual(
      expect.objectContaining({ snippets: ['8-2'], table_index: 1 }),
    )
    expect(merged.global_notes).toBeNull()
  })

  it('fingerprints nested arrays by length and ignores evidence objects', () => {
    expect(
      catalogFingerprint({
        id: '8',
        children: [{ value: 'a' }],
        _evidence: { id: 'one' },
      }),
    ).toBe(
      catalogFingerprint({
        id: '8',
        children: [{ value: 'b' }],
        _evidence: { id: 'two' },
      }),
    )
  })
})

describe('extractCatalog orchestration', () => {
  it('falls back once to the whole document when no marker resolves', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ records: [{ start_marker: '# Missing' }] })
      .mockResolvedValueOnce(records[0])

    const extraction = await extractCatalog({
      document: markdown,
      schema: burial,
      generate,
    })

    expect(extraction.warnings).toEqual(['boundary_fallback'])
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[0]?.[0].instructions).toContain('record.entries')
    expect(generate.mock.calls[0]?.[0].instructions).not.toContain('record.entries[].fundliste')
    expect(generate.mock.calls[1]?.[0].document).toBe(markdown)
  })

  it('retries a suspicious section once and keeps source order', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(boundaries)
      .mockResolvedValueOnce(records[0])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(records[1])

    const extraction = await extractCatalog({
      document: markdown,
      schema: burial,
      generate,
    })
    const entries = extraction.result.entries as Array<Record<string, unknown>>

    expect(generate).toHaveBeenCalledTimes(4)
    expect(entries.map((entry) => entry.Grav_id)).toEqual(['8', '13'])
    expect(extraction.warnings).toEqual([])
    expect(generate.mock.calls[3]?.[0].instructions).toContain('STRICT RETRY')
  })

  it('retries duplicate fingerprints once', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(boundaries)
      .mockResolvedValueOnce(records[0])
      .mockResolvedValueOnce(records[0])
      .mockResolvedValueOnce(records[1])

    const extraction = await extractCatalog({
      document: markdown,
      schema: burial,
      generate,
    })

    expect(generate).toHaveBeenCalledTimes(4)
    expect((extraction.result.entries as Array<Record<string, unknown>>).map((entry) => entry.Grav_id)).toEqual([
      '8',
      '13',
    ])
  })

  it('retries an empty nested object-array when the section has table rows', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ record_id: '8', start_marker: '# Grav 8', end_marker: '' }],
      })
      .mockResolvedValueOnce({ Grav_id: '8', fundliste: [] })
      .mockResolvedValueOnce(records[0])

    const twoRowTable = markdown.replace('| 8-2 | Jernspænde |', '| 8-2 | Jernspænde |\n| 8-3 | Kniv |')
    await extractCatalog({ document: twoRowTable, schema: burial, generate })

    expect(generate).toHaveBeenCalledTimes(3)
    expect(generate.mock.calls[2]?.[0].instructions).toContain('STRICT RETRY')
  })

  it('uses Python container truthiness when deciding whether nested objects are empty', async () => {
    const schema: ExtractionSchemaEnvelope = {
      record: { items: [{ id: '', details: { rows: [] } }] },
      _schema_metadata: {
        'record.items': { instance_description: 'Each heading is one item.' },
      },
    }
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ record_id: '1', start_marker: '# Item', end_marker: '' }],
      })
      .mockResolvedValueOnce({ id: '', details: { rows: [] } })
      .mockResolvedValueOnce({ id: '1', details: { rows: [] } })

    await extractCatalog({ document: '# Item', schema, generate })

    expect(generate).toHaveBeenCalledTimes(3)
  })

  it('does not retry a suspicious section more than once', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ record_id: '8', start_marker: '# Grav 8', end_marker: '' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const extraction = await extractCatalog({
      document: markdown,
      schema: burial,
      generate,
    })

    expect(generate).toHaveBeenCalledTimes(3)
    expect(extraction.result.entries).toEqual([expect.objectContaining({ Grav_id: null, fundliste: [] })])
  })

  it('retries one thrown record call and retains the conformed empty record if retry fails', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ record_id: '8', start_marker: '# Grav 8', end_marker: '' }],
      })
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('retry failure'))

    const extraction = await extractCatalog({
      document: markdown,
      schema: burial,
      generate,
    })

    expect(generate).toHaveBeenCalledTimes(3)
    expect(extraction.result.entries).toEqual([expect.objectContaining({ Grav_id: null, fundliste: [] })])
  })
})
