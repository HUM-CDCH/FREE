/**
 * The Parsing Service's Evidence links, as durable saved values carry them (`durableValueSchema` `evidence.producer`),
 * and their projection onto the review rail's `EvidenceLink`.
 */
import { z } from 'zod'

const path = z.array(z.union([z.string(), z.number().int().nonnegative()]))
const span = z.object({ segment: z.string().regex(/^p\d+_s\d+$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
const finite = z.number().finite()
/** A box in PDF points from the top-left of the displayed page, as `bbox_pt` is. */
const valueBox = z.tuple([finite, finite, finite, finite]).refine(([x0, y0, x1, y1]) => x0 < x1 && y0 < y1, { message: 'a value box must have positive area' })
/** kei-exp's `Link`, with `path` and `bbox_pt` as lists; versions 2 and 3 extend it. `value_boxes_pt` (ADR 0031): where the
 *  value prints on the link's page, one box per printed line, or per printed word where it was placed from a scan's page
 *  image; absent when nothing was placed. */
const linkSchema = z.object({
  path,
  segment: z.string().regex(/^p\d+_s\d+$/),
  page: z.number().int().positive(),
  bbox_pt: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  verbatim: z.boolean(),
  // Historical producers counted candidates or alternative locations. New producers omit this diagnostic.
  hits: z.number().int().nonnegative().optional(),
  linked_by: z.enum(['lexical', 'model']),
  cell: z
    .string()
    .regex(/^r\d+_c\d+$/)
    .nullable()
    .optional(),
  precision: z.enum(['cell', 'segment', 'input']).optional(),
  value_boxes_pt: z.array(valueBox).min(1).max(64).optional(),
})
/** One grounded value's evidence (version 1). An Article link may carry `location`: the value's unique printing in its
 *  selected candidate, as code-point spans and the printed text. */
export const evidenceSchema = linkSchema.extend({
  location: z.object({ spans: z.array(span.strict()).length(1), raw: z.string().min(1) }).strict().optional(),
}).refine(link => link.location?.spans.every(each => each.segment === link.segment && each.start < each.end) ?? true,
  { path: ['location'], message: 'location spans must be non-empty ranges in the link\'s segment' })
/** Version 2 evidence (`kie/extract/grounded.py` `_link`): the version 1 link plus the raw code-point spans of the value,
 *  its key, its provenance and alternatives, and the precision its box can claim. */
export const groundedEvidenceSchema = linkSchema.extend({
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
/** Version 3 evidence (`kie/extract/unified.py` `_link`): a located value, its literal span or the passage that
 *  supports a yes/no, a label or a derived value, and the occurrence of the list item it belongs to. `verification`:
 *  a separate verification accepted it; `lexical`: a single-pass method (defaults 6) where only code located it. */
export const unifiedEvidenceSchema = linkSchema.extend({
  linked_by: z.enum(['verification', 'lexical']),
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

const valueBoxes = (link: { value_boxes_pt?: [number, number, number, number][] }) =>
  link.value_boxes_pt ? { valueBoxes: link.value_boxes_pt.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 })) } : {}

/** A version 3 link as the Extraction keeps it: a located value with its spans (`VerifiedGrounding`). */
export function unifiedEvidenceLink(link: z.infer<typeof unifiedEvidenceSchema>, evidenceAnchorId: string) {
  return {
    resultPath: link.path, evidenceAnchorId, precision: link.precision, verbatim: link.verbatim,
    grounding: {
      linkedBy: link.linked_by, support: link.support, textSpans: link.spans, alternatives: link.alternatives,
      precision: link.precision, raw: link.raw, itemSpans: link.item,
    },
    ...valueBoxes(link),
  }
}

/** A version 1 link as the Extraction keeps it. */
export function plainEvidenceLink(link: z.infer<typeof evidenceSchema>, evidenceAnchorId: string) {
  return {
    resultPath: link.path, evidenceAnchorId,
    ...(link.precision ? { precision: link.precision } : {}),
    verbatim: link.verbatim,
    ...(link.linked_by === 'lexical' ? { linkedBy: 'lexical' as const } : {}),
    // A display location only: never `grounding`, which names a version 2 or 3 rule and its review wording.
    ...(link.location ? { location: { textSpans: link.location.spans, raw: link.location.raw } } : {}),
    ...valueBoxes(link),
  }
}
/** The recipe's rule attribution is independent of a verifier's support. */
export function groundedEvidenceLink(link: z.infer<typeof groundedEvidenceSchema>, evidenceAnchorId: string) {
  return {
    resultPath: link.path, evidenceAnchorId, precision: link.precision,
    verbatim: link.verbatim,
    grounding: {
      linkedBy: link.linked_by, provenance: link.provenance, textSpans: link.spans, keySpans: link.key_spans,
      alternatives: link.alternatives, heading: link.heading, precision: link.precision, raw: link.raw,
      normalized: link.normalized && {
        value: link.normalized.value, rule: link.normalized.rule,
        keySpan: link.normalized.key_span, expansionSpan: link.normalized.expansion_span,
      },
    },
    ...valueBoxes(link),
  }
}
