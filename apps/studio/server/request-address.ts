import { isIP } from 'node:net'

export function normalizeClientAddress(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || 'unknown'
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = normalized.slice('::ffff:'.length)
    if (isIP(ipv4) === 4) return ipv4
  }
  return normalized
}
