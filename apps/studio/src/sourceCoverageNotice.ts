import type { SourceCoverage } from '../shared/schemaSuggestionSource.contract'

const count = (value: number) => value.toLocaleString('en-US')

/** "1–3, 7 and 9–10": consecutive page numbers collapse into a range. */
function pageList(pages: readonly number[]): string {
  const runs: string[] = []
  for (let index = 0; index < pages.length; ) {
    let end = index
    while (end + 1 < pages.length && pages[end + 1] === pages[end]! + 1) end += 1
    runs.push(end === index ? `${pages[index]}` : `${pages[index]}–${pages[end]}`)
    index = end + 1
  }
  return runs.length === 1 ? runs[0]! : `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}`
}

/** The researcher-facing statement of what a Schema Suggestion did not read of its source; null when it read it all. */
export function sourceCoverageNotice(coverage: SourceCoverage): string | null {
  if (coverage.complete) return null
  const pages = [...new Set(coverage.omitted.flatMap((omission) => (omission.page === null ? [] : [omission.page])))]
    .sort((a, b) => a - b)
  const unpaged = coverage.omitted.some((omission) => omission.page === null)
  const where =
    pages.length === 0
      ? 'the middle of the source'
      : `the middle of page${pages.length === 1 ? '' : 's'} ${pageList(pages)}${unpaged ? ' and of the text before the first page' : ''}`
  const unread = coverage.omitted.reduce((total, omission) => total + omission.end - omission.start, 0)
  return `Suggested from excerpts: ${where} was not read (${count(unread)} of ${count(coverage.sourceCharacters)} characters).`
}

/** The researcher-facing statement for a Source Document suggestion the common-schema merge did not read. */
export const UNCOMBINED_NOTICE =
  'Left out of the common fields: the selected suggestions together were too long to combine in one request.'
