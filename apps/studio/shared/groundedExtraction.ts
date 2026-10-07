import { z } from 'zod'

export const resultPathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative()]))
  .min(1)

export type ResultPath = z.infer<typeof resultPathSchema>

/** A half-open range of Unicode code points in one canonical segment's text (`p{page}_s{index}`); not UTF-16. */
export const textSpanSchema = z
  .object({
    segment: z.string().regex(/^p\d+_s\d+$/),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()

export type TextSpan = z.infer<typeof textSpanSchema>

/** Version 2 (recipe Catalog) evidence detail: what tied the value to its field and where exactly it is. */
export const evidenceGroundingSchema = z
  .object({
    linkedBy: z.enum(['key', 'structure']),
    provenance: z.enum(['token', 'positional', 'inherited']),
    textSpans: z.array(textSpanSchema).min(1),
    keySpans: z.array(textSpanSchema),
    alternatives: z.array(z.array(textSpanSchema)),
    heading: z.string().nullable(),
    precision: z.enum(['cell', 'segment', 'input']),
    raw: z.string(),
    // The document's own glossary expansion of `raw`; the Extraction Result keeps the raw value.
    normalized: z
      .object({ value: z.string(), rule: z.literal('glossary'), keySpan: textSpanSchema, expansionSpan: textSpanSchema })
      .strict()
      .nullable(),
  })
  .strict()

/** Version 3 (unified Catalog) evidence detail: a separate verification accepted the value; `literal` spans print it,
 *  `supporting` spans are the passage that supports a yes/no, a label or a derived value. */
export const verifiedGroundingSchema = z
  .object({
    linkedBy: z.literal('verification'),
    support: z.enum(['literal', 'supporting']),
    textSpans: z.array(textSpanSchema).min(1),
    alternatives: z.array(z.array(textSpanSchema)),
    precision: z.enum(['cell', 'segment', 'input']),
    raw: z.string(),
    itemSpans: z.array(textSpanSchema).nullable(),
  })
  .strict()

export const evidenceLinkSchema = z
  .object({
    resultPath: resultPathSchema,
    evidenceAnchorId: z.string().min(1),
    precision: z.enum(['cell', 'segment', 'input']).optional(),
    // Grounding's lexical checks; absent on booleans and on older links.
    verbatim: z.boolean().optional(),
    lexicalHits: z.number().int().nonnegative().optional(),
    // Absent means the grounder chose the anchor.
    linkedBy: z.enum(['citation_lexical', 'lexical']).optional(),
    // Present only on version 2 and version 3 results.
    grounding: z.union([evidenceGroundingSchema, verifiedGroundingSchema]).optional(),
  })
  .strict()

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>
