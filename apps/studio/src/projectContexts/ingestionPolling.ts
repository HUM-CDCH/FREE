import type { SourceIngestionListing } from '../../shared/sourceDocumentIngestion.contract'
import { ProjectContextRequestError } from './transport'

export const INGESTION_ACTIVE_POLL_MS = 3000
export const INGESTION_IDLE_POLL_MS = 30000
export const INGESTION_BACKOFF_MS = [3000, 6000, 12000, 30000] as const

export type IngestionReading =
  | { kind: 'listed'; listing: SourceIngestionListing }
  | { kind: 'unavailable' }
  /** 404: the Project Context no longer exists for this account. */
  | { kind: 'gone' }

export type IngestionPoller = { readNow(): void; stop(): void }

export type IngestionPollingOptions = {
  /** Reads the listing; the poller does not know which IDs to name, the provider does. */
  list: (signal: AbortSignal) => Promise<SourceIngestionListing>
  onReading: (reading: IngestionReading) => void
  /** Whether the next read should come soon: live rows listed, or admitted uploads not yet resolved. */
  busy: () => boolean
  isHidden?: () => boolean
  onVisible?: (listener: () => void) => () => void
}

function documentVisibility(listener: () => void): () => void {
  const changed = () => {
    if (!document.hidden) listener()
  }
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

/**
 * Reads one Project Context's Source Ingestions: at once, then every 3 s while busy and every 30 s otherwise (so an
 * open tab still discovers work admitted elsewhere), never while the page is hidden, and never two reads at a time.
 * A failed read backs off and is reported as `unavailable`, never as an empty listing; a 404 stops the poller.
 */
export function startIngestionPolling(options: IngestionPollingOptions): IngestionPoller {
  const isHidden = options.isHidden ?? (() => document.hidden)
  const onVisible = options.onVisible ?? documentVisibility
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading: AbortController | null = null
  let failures = 0
  // A readNow() that arrived while a read was in flight: read once more right after it.
  let again = false
  const schedule = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(read, ms)
  }
  function read() {
    if (stopped || reading) return
    if (isHidden()) return // resumes through onVisible
    const controller = new AbortController()
    reading = controller
    options.list(controller.signal).then(
      (listing) => {
        reading = null
        if (stopped || controller.signal.aborted) return
        failures = 0
        options.onReading({ kind: 'listed', listing })
        schedule(again ? 0 : options.busy() ? INGESTION_ACTIVE_POLL_MS : INGESTION_IDLE_POLL_MS)
        again = false
      },
      (error: unknown) => {
        reading = null
        if (stopped || controller.signal.aborted) return
        if (error instanceof ProjectContextRequestError && error.status === 404) {
          stopped = true
          stopVisible()
          options.onReading({ kind: 'gone' })
          return
        }
        options.onReading({ kind: 'unavailable' })
        schedule(again ? 0 : INGESTION_BACKOFF_MS[Math.min(failures++, INGESTION_BACKOFF_MS.length - 1)]!)
        again = false
      },
    )
  }
  const stopVisible = onVisible(() => {
    clearTimeout(timer)
    read()
  })
  schedule(0)
  return {
    readNow() {
      if (stopped) return
      if (reading) {
        again = true
        return
      }
      clearTimeout(timer)
      read()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      reading?.abort()
      stopVisible()
    },
  }
}
