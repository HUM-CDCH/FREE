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
    // Present only on version 2 results.
    grounding: evidenceGroundingSchema.optional(),
  })
  .strict()

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>

export const cleanExtractionResultSchema = z.record(z.string(), z.json())

export const groundedModelAttributionSchema = z
  .object({
    extraction: z.json(),
    grounding: z.json(),
  })
  .strict()

export type GroundedModelAttribution = z.infer<
  typeof groundedModelAttributionSchema
>

export const groundedExtractionPayloadSchema = z
  .object({
    result: cleanExtractionResultSchema,
    evidenceLinks: z.array(evidenceLinkSchema),
  })
  .strict()

export type GroundedExtractionPayload = z.infer<
  typeof groundedExtractionPayloadSchema
>

export function resultPathKey(path: ResultPath): string {
  return JSON.stringify(path)
}

export function resultValueAtPath(
  result: Record<string, unknown>,
  path: ResultPath,
): unknown {
  let value: unknown = result
  for (const segment of path) {
    if (Array.isArray(value)) {
      if (
        typeof segment !== 'number' ||
        segment >= value.length ||
        !Object.hasOwn(value, segment)
      )
        return undefined
      value = value[segment]
      continue
    }
    if (
      !value ||
      typeof value !== 'object' ||
      typeof segment !== 'string' ||
      !Object.hasOwn(value, segment)
    )
      return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

export type PopulatedResultScalar = string | number | boolean

export function isPopulatedResultScalar(
  value: unknown,
): value is PopulatedResultScalar {
  return (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.trim().length > 0)
  )
}

export function evidenceLinksHaveUniqueScalarPaths(
  result: Record<string, unknown>,
  links: readonly EvidenceLink[],
): boolean {
  const paths = new Set<string>()
  for (const link of links) {
    const key = resultPathKey(link.resultPath)
    if (paths.has(key)) return false
    paths.add(key)
    if (!isPopulatedResultScalar(resultValueAtPath(result, link.resultPath)))
      return false
  }
  return true
}
