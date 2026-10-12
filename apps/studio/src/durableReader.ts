import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DurablePage } from 'extraction/durable-types'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { ApiRequestError } from './api'
import { readDurable, type DurableState } from './durableExtractionApi'
import { EXTRACTION_UNAVAILABLE, MONITOR_DISCONNECTED } from './useExtraction'

/** What one Extraction's reader last accepted. */
export type DurableReading = {
  /** The head state; null until the first read. */
  state: DurableState | null
  /** Every value of the latest results, read only while a page consumer wants them. */
  latestPage: DurablePage | null
  /** Why the latest values could not be read; `latestPage` stays the one before. */
  pageError: string | null
  /** `reconnecting` reads on with backoff; `failed` reads again only through `refresh()`. */
  connection: 'connected' | 'reconnecting' | 'failed'
  /** Why the state could not be read; `state` stays the last one accepted. */
  error: string | null
}
/** A control command's answer (`POST …/durable/control`). */
export type ControlReceipt = { controlVersion: number; status: DurableState['status']; pendingResume: boolean }
export type DurableReader = ReturnType<typeof createDurableReader>

const ACTIVE: ReadonlySet<string> = new Set(['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'])
const LIVE_MS = 1_500, SETTLED_MS = 30_000

/** A network error, a server or gateway error, a timeout or a rate limit may pass; any other refusal will not. */
export const transientReadError = (error: unknown) => error instanceof TypeError ||
  error instanceof ApiRequestError && (error.status >= 500 || error.status === 408 || error.status === 429)

const older = (a: DurableState, b: DurableState) => a.controlVersion < b.controlVersion || a.controlVersion === b.controlVersion &&
  (a.snapshotVersion < b.snapshotVersion || a.snapshotVersion === b.snapshotVersion && a.feedbackVersion < b.feedbackVersion)

/**
 * The workspace's one reader of an Extraction's durable state; `seed` gives its status until the first read. It reads
 * 1.5 s after each read while the run can change by itself, else every 30 s and on focus, and never while the tab is
 * hidden (one read when it shows again). One read is in flight at a time; a trigger during it asks for exactly one
 * more. Nothing is requested until something subscribes or wants pages.
 */
export function createDurableReader(seed: ExtractionAttempt) {
  const id = seed.extractionId
  let reading: DurableReading = { state: null, latestPage: null, pageError: null, connection: 'connected', error: null }
  const listeners = new Set<() => void>()
  let listening = false, disposed = false, reads = 0, consumers = 0, failures = 0
  let inFlight: AbortController | null = null, again = false, forced = false, suspended = false
  /** The newest receipt's controlVersion: an observation below it was read before that command answered. */
  let floor = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  /** `refresh()` calls the next read answers. */
  let waiting: (() => void)[] = []

  function publish(next: Partial<DurableReading>) {
    if ((Object.keys(next) as (keyof DurableReading)[]).every(key => next[key] === reading[key])) return
    reading = { ...reading, ...next }
    for (const listener of listeners) listener()
  }
  const live = () => ACTIVE.has(reading.state?.status ?? seed.executionStatus) || Boolean(reading.state?.pendingResume)
  const behind = () => !reading.latestPage || reading.state !== null &&
    (reading.latestPage.snapshotVersion !== reading.state.snapshotVersion || reading.latestPage.feedbackVersion !== reading.state.feedbackVersion)
  const onFocus = () => { if (!live()) trigger() }
  const onVisibility = () => {
    if (!document.hidden) return trigger()
    // Hidden mid-read: that read stops too (its values read, its retries); it is no failure, and its callers wait for
    // the read on return.
    if (inFlight) { suspended = true; inFlight.abort() }
  }

  function trigger() {
    if (disposed) return
    if (inFlight) { again = true; return }
    if (document.hidden || reading.connection === 'failed' && !forced) return
    clearTimeout(timer)
    void read()
  }

  /** The status first: a slow values read must not hold back the run button. */
  function acceptState(state: DurableState) {
    const previous = reading.state
    if (disposed || state.controlVersion < floor || previous && older(state, previous)) return
    publish({ state: previous && JSON.stringify(previous) === JSON.stringify(state) ? previous : state, connection: 'connected', error: null })
  }

  function accept({ state, page, pageError }: Awaited<ReturnType<typeof readDurable>>) {
    const previous = reading.state
    // A command bumps controlVersion and a worker never does: an older triple was read before what this reader holds.
    if (state.controlVersion < floor || previous && older(state, previous)) return publish({ connection: 'connected', error: null })
    publish({
      state: previous && JSON.stringify(previous) === JSON.stringify(state) ? previous : state,
      latestPage: page,
      pageError: pageError === undefined ? null : pageError instanceof Error ? pageError.message : 'Unable to update saved results.',
      connection: 'connected', error: null,
    })
  }

  async function read() {
    const controller = new AbortController(), answered = waiting
    inFlight = controller; waiting = []; forced = false; reads += 1
    let delay: number | null = null, resumes = false
    try {
      const next = await readDurable(id, controller.signal, reading.latestPage, consumers > 0, acceptState)
      if (disposed) return
      failures = 0
      accept(next)
      delay = live() ? LIVE_MS : SETTLED_MS
    } catch (error) {
      if (disposed) return
      // A refresh() hidden mid-read stays forced, so it also restarts a stopped reader; if the tab showed again
      // before the abort landed, `again` restarts it now (trigger() waits while hidden).
      if (suspended) { resumes = true; forced ||= answered.length > 0; waiting = [...answered, ...waiting] }
      else {
        const transient = transientReadError(error)
        publish({
          connection: transient ? 'reconnecting' : 'failed',
          error: error instanceof ApiRequestError && (error.status === 403 || error.status === 404) ? EXTRACTION_UNAVAILABLE
            : transient && live() ? MONITOR_DISCONNECTED : transient || !(error instanceof Error) ? 'Unable to update saved results.' : error.message,
        })
        if (transient) delay = Math.min(SETTLED_MS, (live() ? LIVE_MS : SETTLED_MS) * 2 ** failures++)
      }
    } finally {
      inFlight = null; suspended = false
      if (!resumes) for (const done of answered) done()
    }
    // A subscriber may have disposed the reader while it published.
    if (disposed) return
    if (again) { again = false; trigger() }
    else if (delay !== null) timer = setTimeout(trigger, delay)
  }

  function listen() {
    if (listening || disposed) return
    listening = true
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    // Deferred, so a page consumer that registers in the same commit is known to the first read.
    void Promise.resolve().then(() => { if (reads === 0) trigger() })
  }

  return {
    extractionId: id,
    snapshot: () => reading,
    subscribe(listener: () => void) {
      listeners.add(listener)
      listen()
      return () => { listeners.delete(listener) }
    },
    /** Reads the latest values too while the returned release is not called (DurableResults, mounted). */
    wantPages() {
      consumers += 1
      if (listening && behind()) trigger()
      listen()
      let held = true
      return () => { if (held) { held = false; consumers -= 1 } }
    },
    /** Reads again after a command or a save, never answered by a read already in flight; also ends `failed`. */
    refresh() {
      return new Promise<void>(resolve => {
        if (disposed) return resolve()
        waiting.push(resolve)
        forced = true
        listen()
        trigger()
      })
    },
    acceptReceipt(receipt: ControlReceipt) {
      if (disposed) return
      // Also before the first observation: a read already in flight is older than this command and must not land.
      floor = Math.max(floor, receipt.controlVersion)
      const state = reading.state
      // Worker transitions never bump controlVersion, so an observation at the receipt's version already holds it.
      if (state && receipt.controlVersion > state.controlVersion)
        publish({ state: { ...state, controlVersion: receipt.controlVersion, status: receipt.status, pendingResume: receipt.pendingResume } })
    },
    dispose() {
      disposed = true
      inFlight?.abort()
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      listeners.clear()
      for (const done of waiting) done()
      waiting = []
    },
  }
}

const unsubscribed = () => () => {}, unread = () => null
/** The reader's last accepted reading; null without a reader. */
export const useDurableReading = (reader: DurableReader | null | undefined): DurableReading | null =>
  useSyncExternalStore(reader?.subscribe ?? unsubscribed, reader?.snapshot ?? unread)

/**
 * One controller per key, created by an effect (its factory makes no request) and disposed a microtask after its
 * effect's cleanup unless StrictMode's replay reclaims it (useSchemaEditorController's rule); a new key replaces it.
 */
export function useKeyedController<T extends { dispose(): void }>(key: string | null, factory: () => T): T | null {
  const [held, setHeld] = useState<{ key: string; controller: T } | null>(null)
  const disposal = useRef<{ key: string; controller: T; cancelled: boolean } | null>(null)
  useEffect(() => {
    if (key === null) return
    const scheduled = disposal.current
    let controller: T
    if (scheduled?.key === key && !scheduled.cancelled) {
      scheduled.cancelled = true
      controller = scheduled.controller
    } else {
      // Created here, never while rendering: StrictMode renders twice, and a render's controller could go undisposed.
      controller = factory()
    }
    setHeld(held => held?.controller === controller ? held : { key, controller })
    return () => {
      const pending = { key, controller, cancelled: false }
      disposal.current = pending
      queueMicrotask(() => {
        if (pending.cancelled) return
        controller.dispose()
        // Forgotten once disposed, so the key coming back later gets a new controller.
        if (disposal.current === pending) disposal.current = null
      })
    }
    // A controller belongs to its key: the factory of the render that named the key makes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return held?.key === key ? held.controller : null
}
