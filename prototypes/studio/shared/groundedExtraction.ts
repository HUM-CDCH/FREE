import { z } from 'zod'

export const resultPathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative()]))
  .min(1)

export type ResultPath = readonly (string | number)[]

export const evidenceLinkSchema = z
  .object({
    resultPath: resultPathSchema,
    evidenceAnchorId: z.string().min(1),
  })
  .strict()

export type EvidenceLink = {
  resultPath: ResultPath
  evidenceAnchorId: string
}

export const cleanExtractionResultSchema = z.record(z.string(), z.json())

export const groundedModelAttributionSchema = z
  .object({
    extraction: z.json(),
    grounding: z.json(),
  })
  .strict()

export type GroundedModelAttribution = {
  extraction: unknown
  grounding: unknown
}

export const groundedExtractionPayloadSchema = z
  .object({
    result: cleanExtractionResultSchema,
    evidenceLinks: z.array(evidenceLinkSchema),
  })
  .strict()

export type GroundedExtractionPayload = {
  result: Record<string, unknown>
  evidenceLinks: EvidenceLink[]
}

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
