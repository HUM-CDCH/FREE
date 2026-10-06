/**
 * The Parsing Service's Evidence links, as durable saved values carry them (`durableValueSchema` `evidence.producer`),
 * and their projection onto the review rail's `EvidenceLink`.
 */
import { z } from 'zod'

const path = z.array(z.union([z.string(), z.number().int().nonnegative()]))
/** One grounded value's evidence: kei-exp's `Link`, with `path` and `bbox_pt` as lists. */
export const evidenceSchema = z.object({
  path,
  segment: z.string().regex(/^p\d+_s\d+$/),
  page: z.number().int().positive(),
  bbox_pt: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  verbatim: z.boolean(),
  hits: z.number().int().nonnegative(),
  linked_by: z.enum(['lexical', 'model']),
  cell: z
    .string()
    .regex(/^r\d+_c\d+$/)
    .nullable()
    .optional(),
  precision: z.enum(['cell', 'segment', 'input']).optional(),
})
const span = z.object({ segment: z.string().regex(/^p\d+_s\d+$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
/** Version 2 evidence (`kie/extract/grounded.py` `_link`): the version 1 link plus the raw code-point spans of the value,
 *  its key, its provenance and alternatives, and the precision its box can claim. */
export const groundedEvidenceSchema = evidenceSchema.extend({
  linked_by: z.enum(['key', 'structure']),
  spans: z.array(span).min(1),
  alternatives: z.array(z.array(span)),
  provenance: z.enum(['token', 'positional', 'inherited']),
  key_spans: z.array(span),
  heading: z.string().nullable(),
  precision: z.enum(['cell', 'segment', 'input']),
  raw: z.string(),
  // The document's own glossary expansion of the raw value, which the record keeps unchanged.
  normalized: z.object({ value: z.string(), rule: z.literal('glossary'), key_span: span, expansion_span: span }).nullable(),
})
/** Version 3 evidence (`kie/extract/unified.py` `_link`): a verified value, its literal span or the passage that
 *  supports a yes/no, a label or a derived value, and the occurrence of the list item it belongs to. */
export const unifiedEvidenceSchema = evidenceSchema.extend({
  linked_by: z.literal('verification'),
  support: z.enum(['literal', 'supporting']),
  spans: z.array(span).min(1),
  alternatives: z.array(z.array(span)),
  precision: z.enum(['cell', 'segment', 'input']),
  raw: z.string(),
  item: z.array(span).nullable(),
})

/** The Evidence anchor a kei link names: the segment's text anchor, or the cell's when the link is a table cell. */
export const evidenceAnchorIdOf = (link: { segment: string; cell?: string | null }): string =>
  `a_${link.segment}${link.cell ? `_${link.cell}` : ''}`

/** A version 3 link as the Extraction keeps it: a verified value with its spans (`VerifiedGrounding`). */
export function unifiedEvidenceLink(link: z.infer<typeof unifiedEvidenceSchema>, evidenceAnchorId: string) {
  return {
    resultPath: link.path, evidenceAnchorId, precision: link.precision, verbatim: link.verbatim, lexicalHits: link.hits,
    grounding: {
      linkedBy: link.linked_by, support: link.support, textSpans: link.spans, alternatives: link.alternatives,
      precision: link.precision, raw: link.raw, itemSpans: link.item,
    },
  }
}

/** A version 1 link as the Extraction keeps it. */
export function plainEvidenceLink(link: z.infer<typeof evidenceSchema>, evidenceAnchorId: string) {
  return {
    resultPath: link.path, evidenceAnchorId,
    ...(link.precision ? { precision: link.precision } : {}),
    verbatim: link.verbatim, lexicalHits: link.hits,
    ...(link.linked_by === 'lexical' ? { linkedBy: 'lexical' as const } : {}),
  }
}
/** The recipe's rule attribution is independent of a verifier's support. */
export function groundedEvidenceLink(link: z.infer<typeof groundedEvidenceSchema>, evidenceAnchorId: string) {
  return {
    resultPath: link.path, evidenceAnchorId, precision: link.precision,
    verbatim: link.verbatim, lexicalHits: link.hits,
    grounding: {
      linkedBy: link.linked_by, provenance: link.provenance, textSpans: link.spans, keySpans: link.key_spans,
      alternatives: link.alternatives, heading: link.heading, precision: link.precision, raw: link.raw,
      normalized: link.normalized && {
        value: link.normalized.value, rule: link.normalized.rule,
        keySpan: link.normalized.key_span, expansionSpan: link.normalized.expansion_span,
      },
    },
  }
}
