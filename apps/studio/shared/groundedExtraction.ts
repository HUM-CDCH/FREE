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

/** Version 3 (unified Catalog) evidence detail: a separate verification accepted the value (`verification`), or with a
 *  single pass only code located it (`lexical`); `literal` spans print it, `supporting` spans are the passage that
 *  supports a yes/no, a label or a derived value. */
export const verifiedGroundingSchema = z
  .object({
    linkedBy: z.enum(['verification', 'lexical']),
    support: z.enum(['literal', 'supporting']),
    textSpans: z.array(textSpanSchema).min(1),
    alternatives: z.array(z.array(textSpanSchema)),
    precision: z.enum(['cell', 'segment', 'input']),
    raw: z.string(),
    itemSpans: z.array(textSpanSchema).nullable(),
  })
  .strict()

const valueBoxSchema = z.object({ x0: z.number().finite(), y0: z.number().finite(), x1: z.number().finite(), y1: z.number().finite() }).strict()
  .refine(box => box.x0 < box.x1 && box.y0 < box.y1, { message: 'a value box must have positive area' })

export const evidenceLinkSchema = z
  .object({
    resultPath: resultPathSchema,
    evidenceAnchorId: z.string().min(1),
    precision: z.enum(['cell', 'segment', 'input']).optional(),
    // Whether the producer found the value printed as such; absent on older links.
    verbatim: z.boolean().optional(),
    // Historical repetition diagnostic, retained only for reading saved links.
    lexicalHits: z.number().int().nonnegative().optional(),
    // Absent means the grounder chose the anchor.
    linkedBy: z.enum(['citation_lexical', 'lexical']).optional(),
    // Present only on version 2 and version 3 results.
    grounding: z.union([evidenceGroundingSchema, verifiedGroundingSchema]).optional(),
    // An Article (version 1) link's value printing, for drawing only; never a `grounding`.
    location: z.object({ textSpans: z.array(textSpanSchema).length(1), raw: z.string().min(1) }).strict().optional(),
    // Where the value prints on its page (ADR 0031), for drawing only; Studio checks each box against its anchor.
    valueBoxes: z.array(valueBoxSchema).min(1).max(64).optional(),
  })
  .strict()

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>
