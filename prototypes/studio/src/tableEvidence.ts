import type { Highlight } from './evidenceHighlights'

export function isTableLikeEvidence(
  highlight: Pick<Highlight, 'rowHeader' | 'columnHeader' | 'snippet'>,
): boolean {
  return (
    highlight.rowHeader !== null ||
    highlight.columnHeader !== null ||
    (highlight.snippet?.trim().startsWith('|') ?? false)
  )
}

// A snippet whose single occurrence inside the source scope lands on a
// `| ... |` Markdown table row is table evidence even when the model omitted
// the row/column headers and the pipe prefix (e.g. a continuation-table row
// quoted as bare cell text). This deliberately inspects the snippet — the
// model's claimed source location — not the result value, so a value that
// merely recurs in a table (e.g. "31-7" appearing in both a cell and a
// paragraph) cannot pull prose evidence into the table tier. Requiring a
// single occurrence keeps snippets that also appear in prose non-table.
function snippetOnTableRow(highlight: Highlight, markdown: string | null): boolean {
  const scope = highlight.sourceScope
  const snippet = highlight.snippet
  if (!markdown || !scope || !snippet) return false
  const term = snippet.trim()
  if (!term) return false
  const scopeStart = Math.max(0, scope.markdownStart)
  const scopeEnd = Math.min(markdown.length, scope.markdownEnd)
  let from = scopeStart
  let occurrence = -1
  let count = 0
  for (;;) {
    const start = markdown.indexOf(term, from)
    const end = start + term.length
    if (start === -1 || end > scopeEnd) break
    count += 1
    occurrence = start
    from = end
  }
  if (count !== 1) return false
  const lineStart = markdown.lastIndexOf('\n', occurrence - 1) + 1
  const lineEndRel = markdown.indexOf('\n', occurrence)
  const lineEnd = lineEndRel === -1 ? markdown.length : lineEndRel
  return /^\s*\|/.test(markdown.slice(lineStart, lineEnd))
}

export function isTableEvidence(highlight: Highlight, markdown: string | null): boolean {
  return isTableLikeEvidence(highlight) || snippetOnTableRow(highlight, markdown)
}
