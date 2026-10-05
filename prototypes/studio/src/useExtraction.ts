import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExtractionMethodIntent } from 'extraction/extraction-method'
import { ApiRequestError, readExtraction, requestExtraction } from './api'
import type { ExtractionAttempt, ExtractionStrategy } from '../shared/extraction.contract'

/** Shown when a status read fails; the last known state stays on screen. */
export const MONITOR_DISCONNECTED =
  'Unable to update status. The extraction may still be running.'
/** Shown when the server denies or cannot find the monitored Extraction. */
export const EXTRACTION_UNAVAILABLE =
  'Extraction status is unavailable: it was not found or access was denied.'

type ExtractionRunRequest = Readonly<{
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  catalogRecipe?: string
  /** One-based page the researcher was reading when Run was clicked. */
  startPage?: number
  /** The saved method read at the click; admission refuses it if the account's changed since. */
  method: ExtractionMethodIntent
}>

export type ReviewTarget = {
  sourceRepresentationId: string
  /** Current Schema Revision safe to extract with, or null while the editor draft differs from the acknowledged
   *  revision. */
  schemaRevisionId: string | null
}

type UseExtractionOptions = {
  schemaReady: boolean
  indexing: boolean
  /** The controller's Extraction reached COMPLETED, FAILED or STOPPED while it was observed here. */
  onTerminal: (attempt: ExtractionAttempt, isRerun: boolean) => void
  onError: (message: string) => void
  /** The server refused a run because the Source Representation it names was superseded by reprocessing. Nothing
   *  failed, so `onError` is not called. */
  onSuperseded?: () => void
  /** Admission refused the run (`code`: a changed saved method, a pending migration, a record-scope refusal or
   *  disabled admissions): nothing started. The caller re-reads the saved method on `METHOD_CHANGED`. */
  onMethodChanged?: (message: string, code: string) => void
  initialAttempt?: ExtractionAttempt | null
  reviewTarget?: ReviewTarget | null
  /** Identifies which Source Document `initialAttempt` belongs to: `attempt` is reseeded whenever it changes. */
  documentKey?: string
}

/**
 * One watch over a single Extraction's admission and status. Every status read and callback is bound to the monitor
 * that started it, so a late response for a previous Source Document or Extraction is ignored. Once the durable
 * results reader is mounted it owns status (`acceptDurableStatus`) and this monitor stops.
 */
type Monitor = {
  extractionId: string
  isRerun: boolean
  /** A read failed; polling resumes only through `reconnect()`. */
  paused: boolean
  controller: AbortController
  /** The request this monitor posted, when the server has not acknowledged it (JSON). */
  unacknowledged?: string
}

const TERMINAL: ReadonlySet<ExtractionAttempt['executionStatus']> = new Set(['COMPLETED', 'FAILED', 'STOPPED'])

/** Admitted work whose lifecycle can still change without a researcher's command. */
export function isActive(attempt: ExtractionAttempt | null): boolean {
  return Boolean(attempt && ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(attempt.executionStatus))
}

function definiteRejection(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500
}

/** PR #140: a run on a Source Representation that reprocessing replaced is refused before anything starts. */
const SOURCE_REPRESENTATION_SUPERSEDED = 'source_representation_superseded'
export const METHOD_CHANGED = 'method_changed'
/** Legacy Catalog preferences wait for their migration: refreshable, like a changed method. */
const MIGRATION_REQUIRED = 'catalog_migration_required'
/** New Extraction admission is off until the durable release is verified: nothing was started. */
export const ADMISSIONS_DISABLED = 'extraction_admissions_disabled'
/** A strategy the schema's saved Article/Catalog scope does not name (or none saved): said like a changed method. */
const ADMISSION_REFUSALS: ReadonlySet<string> = new Set([
  METHOD_CHANGED, MIGRATION_REQUIRED, ADMISSIONS_DISABLED, 'record_scope_required', 'record_scope_mismatch',
])

/** The server's own words for a refusal: `ApiRequestError` prefixes its message with `<code>: `. */
function serverMessage(error: ApiRequestError): string {
  const prefix = `${error.code}: `
  return error.code && error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
}

export type ExtractionController = ReturnType<typeof useExtraction>

function pollingDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = window.setTimeout(done, 2_000)
    const onAbort = () => done()
    function done() {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function useExtraction({
  schemaReady,
  indexing,
  onTerminal,
  onError,
  onSuperseded,
  onMethodChanged,
  initialAttempt = null,
  reviewTarget = null,
  documentKey = '',
}: UseExtractionOptions) {
  const [attempt, setAttempt] = useState<ExtractionAttempt | null>(initialAttempt)
  const currentAttemptRef = useRef(attempt)
  useLayoutEffect(() => { currentAttemptRef.current = attempt })
  const [admitting, setAdmitting] = useState(false)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const monitorRef = useRef<Monitor | null>(null)
  /** The run this page started, so its terminal report says whether it was a re-run after the reader took over. */
  const startedRef = useRef<{ extractionId: string; isRerun: boolean } | null>(null)
  const onTerminalRef = useRef(onTerminal)
  useEffect(() => { onTerminalRef.current = onTerminal })

  function stopMonitor() {
    monitorRef.current?.controller.abort()
    monitorRef.current = null
  }

  // Reset during render (not in an effect) when the document or the reopened attempt changes, so no frame renders the
  // previous document's state. A prop catching up to a run admitted here is not a new scope.
  const [rendered, setRendered] = useState({ documentKey, initialExtractionId: initialAttempt?.extractionId })
  const documentChanged = rendered.documentKey !== documentKey
  const initialChanged = rendered.initialExtractionId !== initialAttempt?.extractionId
  if (documentChanged || initialChanged) {
    setRendered({ documentKey, initialExtractionId: initialAttempt?.extractionId })
    if (documentChanged || initialAttempt?.extractionId !== attempt?.extractionId) {
      setAttempt(initialAttempt)
      setAdmitting(false)
      setMonitorError(null)
    }
  }

  /**
   * The only polling loop, until the durable reader takes status over or the work is idle. `seed` is the last attempt
   * read for this monitor (null after an uncertain POST); `immediate` skips the first delay. A read failure pauses the
   * monitor and keeps the last known state; `reconnect()` resumes it.
   */
  async function watch(monitor: Monitor, seed: ExtractionAttempt | null, immediate: boolean) {
    const { signal } = monitor.controller
    const live = () => monitorRef.current === monitor && !signal.aborted
    if (!live()) return
    let latest = seed
    try {
      while (latest === null || isActive(latest)) {
        if (!immediate) await pollingDelay(signal)
        immediate = false
        if (!live()) return
        latest = (await readExtraction(monitor.extractionId, signal)).extraction
        if (!live()) return
        monitor.unacknowledged = undefined
        setAttempt(latest)
      }
      monitorRef.current = null
      if (TERMINAL.has(latest.executionStatus)) onTerminalRef.current(latest, monitor.isRerun)
    } catch (error) {
      if (!live()) return
      monitor.paused = true
      setMonitorError(
        error instanceof ApiRequestError && (error.status === 403 || error.status === 404)
          ? EXTRACTION_UNAVAILABLE
          : MONITOR_DISCONNECTED,
      )
    }
  }

  // The previous scope's monitor stops before anything paints; orphaned reads notice the missing monitor and drop their
  // response.
  const monitoredDocumentRef = useRef(documentKey)
  useLayoutEffect(() => {
    const documentChanged = monitoredDocumentRef.current !== documentKey
    monitoredDocumentRef.current = documentKey
    if (documentChanged || (monitorRef.current && monitorRef.current.extractionId !== initialAttempt?.extractionId)) stopMonitor()
  }, [documentKey, initialAttempt?.extractionId])
  useEffect(() => () => stopMonitor(), [])
  useEffect(() => {
    if (!isActive(initialAttempt)) return
    stopMonitor()
    const monitor: Monitor = {
      extractionId: initialAttempt!.extractionId,
      isRerun: true,
      paused: false,
      controller: new AbortController(),
    }
    monitorRef.current = monitor
    // Deferred so the effect body itself schedules no state update; an aborted monitor (StrictMode re-run, unmount)
    // exits on its first check.
    void Promise.resolve().then(() => watch(monitor, initialAttempt, false))
    return () => {
      monitor.controller.abort()
      if (monitorRef.current === monitor) monitorRef.current = null
    }
    // watch is redeclared each render and reads everything through refs and the monitor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey, initialAttempt?.extractionId])

  function reconnect() {
    const monitor = monitorRef.current
    if (!monitor?.paused) return
    monitor.paused = false
    setMonitorError(null)
    void watch(monitor, attempt?.extractionId === monitor.extractionId ? attempt : null, true)
  }

  /** The durable reader's status for this Extraction. One observer owns status once the reader is mounted. */
  const acceptDurableStatus = useCallback((extractionId: string, executionStatus: ExtractionAttempt['executionStatus']) => {
    const previous = currentAttemptRef.current
    if (!previous || previous.extractionId !== extractionId) return
    const monitor = monitorRef.current
    if (monitor?.extractionId === extractionId) { monitor.controller.abort(); monitorRef.current = null }
    if (previous.executionStatus === executionStatus) return
    const next = { ...previous, executionStatus }
    currentAttemptRef.current = next
    setAttempt(next)
    if (!TERMINAL.has(previous.executionStatus) && TERMINAL.has(executionStatus))
      onTerminalRef.current(next, startedRef.current?.extractionId === extractionId ? startedRef.current.isRerun : true)
  }, [])

  // A new Extraction starts from no Extraction or from one that can no longer continue; any other is controlled with
  // Pause, Resume, Retry and Stop in Results.
  const canRun =
    reviewTarget?.schemaRevisionId != null &&
    schemaReady &&
    !admitting &&
    (!attempt || attempt.executionStatus === 'COMPLETED' || attempt.executionStatus === 'STOPPED') &&
    !indexing

  /**
   * Posts the Extraction, then hands the generated identity to the monitor. Resolves with the persisted attempt once
   * the server has acknowledged it, or null when the request was definitely refused. An uncertain outcome (network
   * failure, gateway error) is reconciled by reading the same identity rather than by posting again, so the admitted
   * run keeps the method it was requested with (design §7).
   */
  async function runRequest(isRerun: boolean, request: ExtractionRunRequest) {
    const running = monitorRef.current
    if (!schemaReady || isActive(attempt) || (running !== null && !running.paused) || indexing)
      return null
    stopMonitor()
    const unacknowledged = JSON.stringify(request)
    const monitor: Monitor = {
      extractionId: running?.paused && running.unacknowledged === unacknowledged ? running.extractionId : crypto.randomUUID(),
      unacknowledged,
      isRerun,
      paused: false,
      controller: new AbortController(),
    }
    monitorRef.current = monitor
    startedRef.current = { extractionId: monitor.extractionId, isRerun }
    setMonitorError(null)
    setAdmitting(true)
    let seed: ExtractionAttempt | null = null
    try {
      seed = await requestExtraction({ id: monitor.extractionId, ...request }, monitor.controller.signal)
    } catch (error) {
      if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
      if (definiteRejection(error)) {
        monitorRef.current = null
        setAdmitting(false)
        if (error.code === SOURCE_REPRESENTATION_SUPERSEDED) onSuperseded?.()
        else if (ADMISSION_REFUSALS.has(error.code ?? '')) onMethodChanged?.(serverMessage(error), error.code!)
        else onError(serverMessage(error))
        return null
      }
    }
    if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
    setAdmitting(false)
    if (seed) {
      monitor.unacknowledged = undefined
      setAttempt(seed)
    }
    void watch(monitor, seed, seed === null)
    return seed
  }

  async function runExtraction(
    method: ExtractionMethodIntent,
    target: ReviewTarget | null = reviewTarget,
    strategy: ExtractionStrategy = 'ARTICLE',
    catalogRecipe: string | null = null,
    startPage: number | null = null,
  ) {
    if (!target?.schemaRevisionId) return null
    return runRequest(attempt !== null, {
      sourceRepresentationRevisionId: target.sourceRepresentationId,
      schemaRevisionId: target.schemaRevisionId,
      strategy,
      ...(strategy === 'CATALOG' && catalogRecipe ? { catalogRecipe } : {}),
      ...(startPage === null ? {} : { startPage }),
      method,
    })
  }

  return {
    attempt,
    /** A run request is awaiting the server's acknowledgement. */
    admitting,
    canRun,
    acceptDurableStatus,
    runExtraction,
    /** Last status read failed; the last known attempt stays on screen. */
    monitorError,
    /** Reads the same Extraction again and resumes polling; never posts. */
    reconnect,
  }
}
