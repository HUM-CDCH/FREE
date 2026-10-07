import type { SchemaNode } from 'extraction/schema'

type ReviewedScalar = string | number | boolean
type ReviewedValue = ReviewedScalar | ReviewedScalar[]

function parseReviewedScalar(
  itemType: Exclude<SchemaNode['type'], 'array' | 'object'>,
  raw: string,
): { value: ReviewedScalar; error: string | null } {
  switch (itemType) {
    case 'boolean':
      if (raw === 'true') return { value: true, error: null }
      if (raw === 'false') return { value: false, error: null }
      return { value: raw, error: 'Choose true or false.' }
    case 'integer': {
      const value = Number(raw)
      return Number.isInteger(value) && raw.trim() !== ''
        ? { value, error: null }
        : { value: raw, error: 'Enter a whole number.' }
    }
    case 'number': {
      const value = Number(raw)
      return Number.isFinite(value) && raw.trim() !== ''
        ? { value, error: null }
        : { value: raw, error: 'Enter a number.' }
    }
    case 'date':
    case 'string':
    case 'verbatim-string':
      return raw.trim() === ''
        ? { value: raw, error: 'Enter a value.' }
        : { value: raw, error: null }
  }
}

export function parseReviewedValue(
  node: SchemaNode | null,
  raw: string,
): { value: ReviewedValue; error: string | null } {
  if (!node)
    return { value: raw, error: 'The pinned schema does not define this value.' }
  if (node.type === 'array') {
    if (node.children) return { value: raw, error: 'Only scalar values can be edited.' }
    const items = raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    if (items.length === 0) return { value: [], error: 'Enter at least one value, separated by commas.' }
    const values: ReviewedScalar[] = []
    for (const item of items) {
      const parsed = parseReviewedScalar(node.itemType, item)
      if (parsed.error) return { value: raw, error: parsed.error }
      values.push(parsed.value)
    }
    return { value: values, error: null }
  }
  if (node.allowedValues && !node.allowedValues.includes(raw))
    return { value: raw, error: 'Choose a value allowed by the pinned schema.' }
  if (node.type === 'object') return { value: raw, error: 'Only scalar values can be edited.' }
  return parseReviewedScalar(node.type, raw)
}
