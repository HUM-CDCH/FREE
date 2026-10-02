/** A scalar the Parsing Service left null because its sources disagreed: an unresolved conflict, not a documented
 *  absence. `resultPath` is absolute in the persisted result (`['records', n, …]`); `candidates` are the values only. */
export type ContestedValue = Readonly<{ resultPath: readonly (string | number)[]; candidates: readonly unknown[] }>

type Path = (string | number)[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isPath = (value: unknown): value is Path =>
  Array.isArray(value) && value.every((step) => typeof step === 'string' || (Number.isInteger(step) && step >= 0))
const absolute = (path: Path) => path[0] === 'records' && typeof path[1] === 'number'

function valueAt(result: unknown, path: readonly (string | number)[]): unknown {
  let node = result
  for (const step of path) {
    if (Array.isArray(node) && typeof step === 'number') node = node[step]
    else if (isRecord(node) && typeof step === 'string') node = node[step]
    else return undefined
  }
  return node
}

/** `{path, candidates}` as kei-exp's `reconcile_values` writes it into an issue's detail; null when it is not that. */
function conflictOf(detail: unknown): { path: Path; candidates: unknown[] } | null {
  let parsed: unknown = detail
  if (typeof detail === 'string') {
    try { parsed = JSON.parse(detail) } catch { return null }
  }
  return isRecord(parsed) && isPath(parsed.path) && Array.isArray(parsed.candidates)
    ? { path: parsed.path, candidates: parsed.candidates }
    : null
}

/**
 * Every value of `result` the service left empty because its sources disagreed, from the persisted diagnostics of any
 * supported artifact version: version 1's `conflicting_values` (one record) and `conflicting_document_values` (every record)
 * issues, and version 2's unresolved competitors. An arbitrated competitor chose a
 * value; a reviewed value, or anything malformed, is not a contested empty value either.
 */
export function contestedValues(diagnostics: unknown, result: unknown): ContestedValue[] {
  if (!isRecord(diagnostics)) return []
  const records = isRecord(result) && Array.isArray(result.records) ? result.records.length : 0
  const found: ContestedValue[] = []
  const everyRecord = (path: Path, candidates: unknown[]) => {
    for (let record = 0; record < records; record += 1) found.push({ resultPath: ['records', record, ...path], candidates })
  }
  for (const issue of Array.isArray(diagnostics.groundingIssues) ? diagnostics.groundingIssues : []) {
    if (!isRecord(issue)) continue
    const conflict = issue.code === 'conflicting_values' || issue.code === 'conflicting_document_values'
      ? conflictOf(issue.detail) : null
    if (!conflict) continue
    if (issue.code === 'conflicting_document_values') everyRecord(conflict.path, conflict.candidates)
    else if (Number.isInteger(issue.record) && (issue.record as number) >= 0)
      found.push({ resultPath: ['records', issue.record as number, ...conflict.path], candidates: conflict.candidates })
  }
  // Version 2 also issues `competitors_unresolved` for each of these; the competitor alone is read.
  const review = diagnostics.grounded
  for (const competitor of isRecord(review) && Array.isArray(review.competitors) ? review.competitors : [])
    if (isRecord(competitor) && competitor.outcome === 'unresolved' && isPath(competitor.path) && absolute(competitor.path)
      && Array.isArray(competitor.candidates))
      found.push({
        resultPath: competitor.path,
        candidates: competitor.candidates.map((candidate) => isRecord(candidate) ? candidate.value : candidate)
          .filter((value) => value !== undefined),
      })
  const seen = new Set<string>()
  return found.filter(({ resultPath }) => {
    const key = JSON.stringify(resultPath)
    if (seen.has(key) || !((resultPath[1] as number) < records)) return false
    seen.add(key)
    const value = valueAt(result, resultPath)
    return value === null || value === undefined || value === ''
  })
}
