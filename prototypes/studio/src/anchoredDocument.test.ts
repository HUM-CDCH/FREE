import { describe, expect, it } from 'vitest'
import bundled from './assets/parsed_document.v2.json'
import { decodeParsedDocument } from './parsedDocument'
import {
  anchoredSource,
  resolveResultAnchors,
  wrapTemplateWithAnchors,
} from './anchoredDocument'

describe('anchoredSource', () => {
  it('labels every canonical passage the model may cite', () => {
    const document = decodeParsedDocument(bundled)
    const { text, anchorIdByLabel } = anchoredSource(document)

    expect(text).toContain('## Page 1')
    expect([...anchorIdByLabel.values()]).toEqual(
      document.evidence_index.anchors.map((anchor) => anchor.anchor_id),
    )
    for (const label of anchorIdByLabel.keys()) expect(text).toContain(`[${label}]`)
    // Nothing else about the Evidence reaches the model.
    expect(text).not.toMatch(/occurrence_id|bbox|content_sha256/)
  })
})

describe('resolveResultAnchors', () => {
  it('resolves cited labels exactly and drops what was never published', () => {
    const labels = new Map([['E1', 'bundled-anchor']])

    expect(
      resolveResultAnchors(
        {
          records: [
            { site: { value: 'Ellekilde', anchor_id: 'E1' } },
            { site: { value: 'Invented', anchor_id: 'E99' } },
          ],
        },
        labels,
      ),
    ).toEqual({
      records: [
        { site: { value: 'Ellekilde', anchor_id: 'bundled-anchor' } },
        { site: { value: 'Invented', anchor_id: null } },
      ],
    })
  })
})

describe('wrapTemplateWithAnchors', () => {
  it('gives every leaf a cited anchor without touching the structure', () => {
    expect(
      wrapTemplateWithAnchors({
        graves: [{ name: 'verbatim-string', sex: ['mand', 'kvinde'] }],
      }),
    ).toEqual({
      graves: [
        {
          name: { value: 'verbatim-string', anchor_id: 'verbatim-string' },
          sex: { value: ['mand', 'kvinde'], anchor_id: 'verbatim-string' },
        },
      ],
    })
  })
})
