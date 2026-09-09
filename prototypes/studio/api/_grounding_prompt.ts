/** The production grounding request and response contract, shared with the
 *  catalog policy experiment so it measures the prompt Studio sends. */
import {
  ExtractionError,
  type GroundingClaimField,
  type GroundingModelRequest,
} from 'extraction'
import type { ExtractModelInput } from './_model.js'

const ABSTAIN = 'NONE'

/** The extraction-model input for one grounding call. */
export function groundingModelInput(request: GroundingModelRequest): ExtractModelInput {
  return {
    document: {
      file: null,
      markdown: [
        '### Canonical Evidence',
        ...Object.entries(request.anchors).map(
          ([label, text]) => `[${label}] ${text}`,
        ),
      ].join('\n'),
      pages: null,
    },
    template: {
      links: Object.fromEntries(
        Object.keys(request.claims).map((label) => [
          label,
          'verbatim-string',
        ]),
      ),
    },
    instruction: groundingInstruction(request.claims, request.claimFields, request.linkedClaims),
    signal: request.signal,
  }
}

export function groundingInstruction(
  claims: Readonly<Record<string, string | number | boolean>>,
  claimFields?: Readonly<Record<string, GroundingClaimField>>,
  linkedClaims?: GroundingModelRequest['linkedClaims'],
): string {
  const described = new Map<string, string>()
  for (const field of Object.values(claimFields ?? {}))
    if (field.description && !described.has(field.field)) described.set(field.field, field.description)
  return [
    'Ground every claim listed after "### Claims". Return exactly the keys shown under "links". Each value must be one exact E label from "### Canonical Evidence", without brackets, or NONE when no candidate directly supports the claim. A translated or normalized claim may cite a passage expressing the same meaning. A claim value or source passage is never a link: do not copy either into the links map. Never cite a C label. Add no snippets, pages, coordinates, explanations, or extra keys.',
    // Both labs found the same wrong link: a string located under another
    // field. The field and record travel with the claim when the policy asks.
    ...(claimFields
      ? ['Each claim names its record and field. Evidence must come from the claim\'s own record and support the value in that field\'s meaning: the same string in an unrelated detail is not evidence.']
      : []),
    ...(described.size > 0 ? ['', '### Fields', ...[...described].map(([field, description]) => `- ${field}: ${description}`)] : []),
    ...(linkedClaims && Object.keys(linkedClaims).length > 0
      ? ['', '### Already linked (context only, return nothing for these)', ...Object.entries(linkedClaims).map(([label, linked]) => {
          const name = linked.field ? `${linked.field.record ? `${linked.field.record}.` : ''}${linked.field.field}: ` : ''
          return `[${label}] ${name}${JSON.stringify(linked.value)} -> ${linked.anchorLabel}`
        })]
      : []),
    '',
    '### Claims',
    ...Object.entries(claims).map(([label, value]) => {
      const field = claimFields?.[label]
      const name = field ? `${field.record ? `${field.record}.` : ''}${field.field}: ` : ''
      return `[${label}] ${name}${JSON.stringify(value)}`
    }),
  ].join('\n')
}

export function groundingSelections(
  result: Readonly<Record<string, unknown>>,
): { claimLabel: string; anchorLabel: string | null }[] {
  if (
    Object.keys(result).length !== 1 ||
    !Object.hasOwn(result, 'links') ||
    result.links === null ||
    typeof result.links !== 'object' ||
    Array.isArray(result.links)
  )
    throw new ExtractionError(
      'grounding_failed',
      'The grounding model returned an invalid response.',
    )
  const selections: { claimLabel: string; anchorLabel: string | null }[] = []
  for (const [claimLabel, anchorLabel] of Object.entries(result.links)) {
    if (typeof anchorLabel !== 'string' || anchorLabel.length === 0)
      throw new ExtractionError(
        'grounding_failed',
        'The grounding model returned an invalid response.',
      )
    selections.push({
      claimLabel,
      anchorLabel: anchorLabel === ABSTAIN ? null : anchorLabel,
    })
  }
  return selections
}
