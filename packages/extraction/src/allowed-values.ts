// A field's allowed values ride in the Extraction Schema as a literal array of
// those values — NuExtract's native closed set, measured to bind: given
// ["mand","kvinde","ukendt"] it answers with one member rather than a list.
//
// Shared because the browser authors the template and the server sends it and
// reads the answer back; both have to agree on what counts as a closed set.

export const SCALAR_FIELD_TYPES = [
  'verbatim-string',
  'string',
  'date',
  'number',
  'integer',
  'boolean',
] as const

export type ScalarFieldType = typeof SCALAR_FIELD_TYPES[number]

export const NON_STRING_SCALAR_FIELD_TYPES = [
  'verbatim-string',
  'date',
  'number',
  'integer',
  'boolean',
] as const satisfies readonly Exclude<ScalarFieldType, 'string'>[]

export const FIELD_TYPES = [
  ...SCALAR_FIELD_TYPES,
  'object',
  'array',
] as const

export type FieldType = typeof FIELD_TYPES[number]

export function isScalarFieldType(value: unknown): value is ScalarFieldType {
  return typeof value === 'string' && (SCALAR_FIELD_TYPES as readonly string[]).includes(value)
}

/**
 * An array of type tokens (`["string"]`) means "array of that type", and a
 * single literal is read as an array too, so a closed set needs two or more
 * non-token values. Same discriminator the model itself applies.
 */
export function isAllowedValues(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.trim().length > 0 &&
        !(FIELD_TYPES as readonly string[]).includes(item),
    )
  )
}
