import { useEffect, useState, type RefObject } from 'react'
import { readSampleFacts } from './api'
import type { SampleFacts as Facts } from '../shared/sampleFacts.contract'
import { Button } from './ui'

/** A suggestion over current facts and the existing run capability; no saved phase or additional admission gate. */
export function SampleFacts({ projectContextId, schemaRevisionId, sourceDocumentIds, busy = false, refresh = 0, refreshRef }: {
  projectContextId: string; schemaRevisionId: string | null; sourceDocumentIds: string[]; busy?: boolean; refresh?: string | number
  refreshRef?: RefObject<((revision?: string) => Promise<void>) | null>
}) {
  const [refreshCount, setRefreshCount] = useState(0)
  const key = JSON.stringify([projectContextId, schemaRevisionId, [...sourceDocumentIds].sort(), refresh, refreshCount])
  const [read, setRead] = useState<{ key: string; facts: Facts } | null>(null)
  useEffect(() => {
    const [project, revision, sources, revisionRefresh, count] = JSON.parse(key) as [string, string | null, string[], string | number, number]
    if (!revision || sources.length === 0 || sources.length > 50) return
    const controller = new AbortController()
    let generation = 0
    const refreshFacts = async (currentRevision = revision) => {
      const request = ++generation
      try {
        const facts = await readSampleFacts(project, currentRevision, sources, controller.signal)
        if (!controller.signal.aborted && request === generation)
          setRead({ key: JSON.stringify([project, currentRevision, sources, revisionRefresh, count]), facts })
      } catch { if (!controller.signal.aborted && request === generation) setRead(null) }
    }
    if (refreshRef) refreshRef.current = refreshFacts
    void refreshFacts()
    return () => {
      controller.abort()
      if (refreshRef?.current === refreshFacts) refreshRef.current = null
    }
  }, [key, refreshRef])
  const facts = read?.key === key ? read.facts : null
  const totals = facts?.sources.reduce((sum, source) => ({ admitted: sum.admitted + source.admitted,
    drafts: sum.drafts + source.savedDrafts, finalized: sum.finalized + source.finalized,
    pages: sum.pages + source.pages.length, reviewedPages: sum.reviewedPages + source.reviewedPages.length }),
    { admitted: 0, drafts: 0, finalized: 0, pages: 0, reviewedPages: 0 })
  return <div className="p-2 text-xs text-ink-muted" aria-live="polite">
    <p>{!sourceDocumentIds.length ? 'Ingest a source to begin.' : !schemaRevisionId ? 'Create or import a schema, then choose pages for a sample.' :
      busy ? 'Admitted work is running. Review its values when it completes.' : totals?.finalized ?
        'Change a field and re-run its pages, try another source, or extract the whole source/start a collection.' :
        totals?.drafts ? 'Continue the saved sample review.' : totals?.admitted ? 'Open the sample status and review its values, or try another sample.' :
          totals ? 'Choose pages and run a sample.' : 'Choose pages to try this schema; whole-source and collection runs remain available.'}</p>
    {totals ? <>
      <p>Selected sources · {totals.admitted} admitted samples · {totals.drafts} saved drafts · {totals.finalized} finalized samples · {totals.pages} unique physical pages ({totals.reviewedPages} in finalized samples)</p>
      {facts!.sources.map((source) => <p key={source.sourceDocumentId}>Source {source.sourceDocumentId.slice(0, 8)} · {source.pages.length} sample pages · {source.finalized} finalized samples · {source.savedDrafts} saved drafts · {source.fullResults} whole-document results</p>)}
      <p>{totals.finalized === 0 ? 'This revision has no finalized samples on the selected source pins.' : 'Samples cover only these pages; they do not establish extraction accuracy or source-wide absence.'} More sampling is optional.</p>
    </> : <p>Sample coverage unavailable{!schemaRevisionId ? ' until the schema is saved' : ''}.</p>}
    {schemaRevisionId && <Button onClick={() => setRefreshCount((count) => count + 1)}>Refresh sample coverage</Button>}
  </div>
}
