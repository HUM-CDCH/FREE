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
export const ADMISSION_UNCERTAIN =
  'Extraction admission is uncertain. Reconnect to check the original run before starting another.'

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
  /** Admission refused the run (`code`: a changed saved method, a pending migration or a record-scope refusal):
   *  nothing started. The caller re-reads the saved method on `METHOD_CHANGED`. */
  onMethodChanged?: (message: string, code: string) => void
  /** The POST may have committed; its identity stays reserved until the monitor reconciles it. */
  onAdmissionUncertain?: (extractionId: string) => void
  initialAttempt?: ExtractionAttempt | null
  reviewTarget?: ReviewTarget | null
  /** Identifies which Source Document `initialAttempt` belongs to: `attempt` is reseeded whenever it changes. */
  documentKey?: string
}

/**
 * One watch over a single Extraction's admission and status. Every status read and callback is bound to the monitor
 * that started it, so a late response for a previous Source Document or Extraction is ignored. The workspace keeps
 * monitoring active work even when the durable results reader is unmounted or inspecting a different Extraction.
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
/** A strategy the schema's saved Article/Catalog scope does not name (or none saved): said like a changed method. */
const ADMISSION_REFUSALS: ReadonlySet<string> = new Set([
  METHOD_CHANGED, MIGRATION_REQUIRED, 'record_scope_required', 'record_scope_mismatch',
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
  onAdmissionUncertain,
  initialAttempt = null,
  reviewTarget = null,
  documentKey = '',
}: UseExtractionOptions) {
  const [attempt, setAttempt] = useState<ExtractionAttempt | null>(initialAttempt)
  const currentAttemptRef = useRef(attempt)
  useLayoutEffect(() => { currentAttemptRef.current = attempt })
  const [admitting, setAdmitting] = useState(false)
  const [unansweredAdmission, setUnansweredAdmission] = useState(false)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const monitorRef = useRef<Monitor | null>(null)
  /** The run this page started, so either observer's terminal report says whether it was a re-run. */
  const startedRef = useRef<{ extractionId: string; isRerun: boolean } | null>(null)
  const onTerminalRef = useRef(onTerminal)
  useEffect(() => { onTerminalRef.current = onTerminal })

  /** Both readers share this transition check, so one terminal transition is announced once. */
  const acceptAttempt = useCallback((next: ExtractionAttempt, isRerun: boolean) => {
    const previous = currentAttemptRef.current
    currentAttemptRef.current = next
    setAttempt(next)
    if (TERMINAL.has(next.executionStatus) &&
      (previous?.extractionId !== next.extractionId || !TERMINAL.has(previous.executionStatus)))
      onTerminalRef.current(next, isRerun)
  }, [])

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
      setUnansweredAdmission(false)
      setMonitorError(null)
    }
  }

  /**
   * The workspace's polling loop, until the work is idle. `seed` is the last attempt
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
        setUnansweredAdmission(false)
        acceptAttempt(latest, monitor.isRerun)
      }
      monitorRef.current = null
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
  const active = isActive(attempt)
  useEffect(() => {
    if (!active || monitorRef.current?.extractionId === attempt?.extractionId) return
    stopMonitor()
    const monitor: Monitor = {
      extractionId: attempt!.extractionId,
      isRerun: startedRef.current?.extractionId === attempt!.extractionId ? startedRef.current.isRerun : true,
      paused: false,
      controller: new AbortController(),
    }
    monitorRef.current = monitor
    // Deferred so the effect body itself schedules no state update; an aborted monitor (StrictMode re-run, unmount)
    // exits on its first check.
    void Promise.resolve().then(() => watch(monitor, attempt, false))
    return () => {
      monitor.controller.abort()
      if (monitorRef.current === monitor) monitorRef.current = null
    }
    // watch is redeclared each render and reads everything through refs and the monitor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey, attempt?.extractionId, active])

  function reconnect() {
    const monitor = monitorRef.current
    if (!monitor?.paused) return
    monitor.paused = false
    setMonitorError(null)
    void watch(monitor, attempt?.extractionId === monitor.extractionId ? attempt : null, true)
  }

  /** The durable reader shares updates, while the workspace keeps observing the latest active Extraction. */
  const acceptDurableStatus = useCallback((extractionId: string, executionStatus: ExtractionAttempt['executionStatus']) => {
    const previous = currentAttemptRef.current
    if (!previous || previous.extractionId !== extractionId) return
    const monitor = monitorRef.current
    if (previous.executionStatus === executionStatus) return
    const next = { ...previous, executionStatus }
    if (monitor?.extractionId === extractionId && !isActive(next)) {
      monitor.controller.abort()
      monitorRef.current = null
      setMonitorError(null)
    }
    acceptAttempt(next, startedRef.current?.extractionId === extractionId ? startedRef.current.isRerun : true)
  }, [acceptAttempt])

  // A new Extraction starts from no Extraction or from one that can no longer continue; any other is controlled with
  // Pause, Resume, Retry and Stop in Results.
  const canRun =
    // App may flush a pending schema draft before supplying its acknowledged revision to runExtraction.
    reviewTarget !== null &&
    schemaReady &&
    !admitting &&
    !unansweredAdmission &&
    (!attempt || attempt.executionStatus === 'COMPLETED' || attempt.executionStatus === 'STOPPED') &&
    !indexing

  /**
   * Posts the Extraction, then hands the generated identity to the monitor. Resolves with the persisted attempt once
   * the server has acknowledged it, or null when the request was definitely refused. An uncertain outcome (network
   * failure, gateway error) is reconciled by reading the same identity rather than by posting again, so the admitted
   * run keeps the method it was requested with (design §7).
   */
  async function runRequest(isRerun: boolean, request: ExtractionRunRequest, originalRetry = false) {
    const running = monitorRef.current
    const unacknowledged = JSON.stringify(request)
    const latest = currentAttemptRef.current
    if (!schemaReady || admitting || indexing ||
      (latest && latest.executionStatus !== 'COMPLETED' && latest.executionStatus !== 'STOPPED') ||
      (running !== null && (!running.paused || (running.unacknowledged && running.unacknowledged !== unacknowledged))))
      return null
    stopMonitor()
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
    setUnansweredAdmission(true)
    let seed: ExtractionAttempt | null = null
    try {
      seed = await requestExtraction({ id: monitor.extractionId, ...request }, monitor.controller.signal)
    } catch (error) {
      if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
      if (definiteRejection(error)) {
        monitorRef.current = null
        setAdmitting(false)
        setUnansweredAdmission(false)
        if (error.code === SOURCE_REPRESENTATION_SUPERSEDED) onSuperseded?.()
        else if (ADMISSION_REFUSALS.has(error.code ?? '') && !originalRetry) onMethodChanged?.(serverMessage(error), error.code!)
        else onError(serverMessage(error))
        return null
      }
    }
    if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
    setAdmitting(false)
    if (seed) {
      monitor.unacknowledged = undefined
      setUnansweredAdmission(false)
      acceptAttempt(seed, isRerun)
    } else onAdmissionUncertain?.(monitor.extractionId)
    void watch(monitor, seed, seed === null)
    return seed
  }

  /** Replays only the unanswered descriptor, including its identity; current page, draft and settings cannot replace it. */
  function retryAdmission() {
    const monitor = monitorRef.current
    if (!monitor?.paused || !monitor.unacknowledged) return Promise.resolve(null)
    return runRequest(monitor.isRerun, JSON.parse(monitor.unacknowledged) as ExtractionRunRequest, true)
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
    /** An unanswered admission can be safely replayed with its original inputs when reads cannot find it. */
    retryAdmission: unansweredAdmission ? retryAdmission : null,
  }
}
