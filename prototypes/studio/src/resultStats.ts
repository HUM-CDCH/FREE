import { isRecord } from '../shared/template'

export type ResultStats = {
  fields: number
  missing: number
  arrayItems: number
}

export function resultStats(value: unknown): ResultStats {
  const stats: ResultStats = { fields: 0, missing: 0, arrayItems: 0 }
  visit(value, stats)
  return stats
}

function visit(value: unknown, stats: ResultStats): void {
  if (Array.isArray(value)) {
    stats.arrayItems += value.length
    if (value.length === 0) {
      stats.fields += 1
      stats.missing += 1
      return
    }
    for (const item of value) {
      visit(item, stats)
    }
    return
  }

  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      visit(child, stats)
    }
    return
  }

  stats.fields += 1
  if (value === null || value === undefined || value === '') {
    stats.missing += 1
  }
}
