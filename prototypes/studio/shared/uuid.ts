export const CANONICAL_UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

export const CANONICAL_UUID = new RegExp(`^${CANONICAL_UUID_PATTERN}$`)

export function normalizeCanonicalUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase()
  return CANONICAL_UUID.test(normalized) ? normalized : null
}
