import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractWithModel } from './_model.js'

const runLiveSmoke = process.env.RUN_CATALOG_REAL_DOCUMENT_SMOKE === '1'

// Ground truth read directly off the canonical Markdown: every top-level
// "# Grav N" heading in examples/Beretning_Ellekilde_8_13.pdf, in source order.
// (The Markdown also contains 4 spurious level-1 headings mid-record from
// Docling mis-detection — see _catalog_sections.test.ts — which the
// recurring-heading-shape detector must ignore.)
const EXPECTED_GRAV_IDS = ['8', '13', '24', '26', '28', '30', '31']

describe.skipIf(!runLiveSmoke)('live Catalog smoke on the full Ellekilde field report', () => {
  it('sections by grave, extracts every grave, and grounds Evidence for each, using whichever provider AI_PROVIDER selects', async () => {
    const markdown = readFileSync(new URL('./test-fixtures/ellekilde-8-13.md', import.meta.url), 'utf8')

    // No deterministic boundary override here: this test exercises the real
    // model for per-section extraction against the heading-derived sections,
    // since the question under test is whether heading-based sectioning
    // finds every grave, not just whether per-section extraction is correct
    // once split.
    const extraction = await extractWithModel({
      document: { file: null, markdown, pages: null },
      template: { _strategy: 'catalog', entries: [{ Grav_id: 'string' }] },
    })

    const entries = extraction.result.entries as Array<Record<string, unknown>>
    expect(entries.map((entry) => entry.Grav_id)).toEqual(EXPECTED_GRAV_IDS)

    const entryEvidence = (extraction.evidence?.entries ?? []) as Array<Record<string, unknown> | null>
    entries.forEach((entry, i) => {
      const fieldEvidence = entryEvidence[i]?.Grav_id as
        | { snippet?: unknown; page?: unknown }
        | undefined
      expect(fieldEvidence, `entry Grav_id=${String(entry.Grav_id)} has no Grav_id evidence`).toBeTypeOf('object')
      expect(
        typeof fieldEvidence?.snippet === 'string' && markdown.includes(fieldEvidence.snippet),
        `entry Grav_id=${String(entry.Grav_id)} has a fabricated (non-verbatim) snippet`,
      ).toBe(true)
      expect(
        typeof fieldEvidence?.page === 'number' && fieldEvidence.page > 0,
        `entry Grav_id=${String(entry.Grav_id)} has no positive absolute page number`,
      ).toBe(true)
    })

    // Absolute page hints should be non-decreasing across graves, since the
    // sections themselves are in document reading order.
    const pages = entryEvidence.map((ev) => (ev?.Grav_id as { page?: number } | undefined)?.page ?? 0)
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i]).toBeGreaterThanOrEqual(pages[i - 1])
    }
  }, 600_000)
})
