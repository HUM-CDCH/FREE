import { randomBytes } from 'node:crypto'

/** A synthetic key no provider issued: distinctive enough to find in any table, dump, file or log. */
export function plantedKey(): string {
  return `FREE_SYNTHETIC_KEY_${randomBytes(8).toString('hex')}`
}

/**
 * Whether `value` holds `key` anywhere: own properties (enumerable or not, so `message`, `stack` and `cause` count),
 * causes, arrays, Map and Set entries, and every string. A property whose getter throws is skipped.
 */
export function holdsKey(value: unknown, key: string): boolean {
  const seen = new Set<object>()
  const walk = (current: unknown): boolean => {
    if (typeof current === 'string') return current.includes(key)
    if (current === null || typeof current !== 'object') return false
    if (seen.has(current)) return false
    seen.add(current)
    if (current instanceof Map) return [...current.entries()].some(([k, v]) => walk(k) || walk(v))
    if (current instanceof Set) return [...current].some(walk)
    if (Array.isArray(current)) return current.some(walk)
    for (const name of Object.getOwnPropertyNames(current)) {
      let property: unknown
      try {
        property = (current as Record<string, unknown>)[name]
      } catch {
        continue
      }
      if (walk(property)) return true
    }
    return false
  }
  return walk(value)
}
