import { useEffect, useRef, useState } from 'react'
import {
  isValidApiBase,
  MODEL_KEY_MAX_LENGTH,
  type ModelConnection,
  type ProbeResult,
  type ProviderDescriptor,
} from '../../shared/modelConfig.contract'
import { apiErrorText, probeModelConnection } from './providerConfig.data'

export type ProbeView =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; result: ProbeResult }
  | { phase: 'error'; message: string }

/**
 * Whether two versions of a connection would be probed differently. A probe depends on the provider, the API base and
 * `hasKey` (which decides the credential), and on whether the connection has a name at all: a blank one is not
 * probed. A rename alone changes nothing, so it never probes again, re-sends a key or clears a model list.
 */
export function probesDiffer(before: ModelConnection, after: ModelConnection): boolean {
  return (
    before.provider !== after.provider ||
    before.baseUrl !== after.baseUrl ||
    before.hasKey !== after.hasKey ||
    !before.name.trim() !== !after.name.trim()
  )
}

/** What a probe's state says, in one line. */
export function probeText(probe: ProbeView | undefined): string {
  if (!probe || probe.phase === 'idle') return 'Not checked yet.'
  if (probe.phase === 'checking') return 'Checking…'
  if (probe.phase === 'error') return probe.message
  return probe.result.message
}

/** Whether a probe's connection answered (`ok`), failed (`failed`), is being checked, or was never checked. */
export function probeTone(probe: ProbeView | undefined): 'ok' | 'failed' | 'checking' | 'idle' {
  if (probe?.phase === 'done') return probe.result.status === 'connected' ? 'ok' : 'failed'
  if (probe?.phase === 'error') return 'failed'
  return probe?.phase === 'checking' ? 'checking' : 'idle'
}

/** The models a probe listed; none until it answered. */
export function probeCatalog(probe: ProbeView | undefined): ProbeResult['catalog'] {
  return probe?.phase === 'done' ? probe.result.catalog : []
}

type LifecycleRecord = {
  sequence: number
  timer: number | undefined
  controller: AbortController | undefined
}

type ProbeInputs = {
  providers: readonly ProviderDescriptor[]
}

/**
 * A probe's `credential` is what the draft says it may carry (`credentialFor`): a key for a connection with `hasKey`,
 * `null` for a keyless one, `undefined` when this browser holds no key for it, which is never probed.
 */
export function useProbeLifecycle({ providers }: ProbeInputs) {
  const [probes, setProbes] = useState<Record<string, ProbeView>>({})
  const lifecycles = useRef(new Map<string, LifecycleRecord>())

  function providerFor(connection: ModelConnection): ProviderDescriptor | undefined {
    return providers.find(({ kind }) => kind === connection.provider)
  }

  function canProbe(connection: ModelConnection, credential: string | null | undefined): boolean {
    const provider = providerFor(connection)
    if (credential === undefined || !provider || !connection.name.trim()) return false
    // A key Studio would refuse (longer than it accepts) is never sent; the key line says why.
    if (typeof credential === 'string' && credential.length > MODEL_KEY_MAX_LENGTH) return false
    return provider.transport !== 'http' || isValidApiBase(connection.baseUrl)
  }

  function supersede(connectionId: string): LifecycleRecord {
    const record = lifecycles.current.get(connectionId) ?? {
      sequence: 0,
      timer: undefined,
      controller: undefined,
    }
    if (!lifecycles.current.has(connectionId)) lifecycles.current.set(connectionId, record)
    record.sequence += 1
    if (record.timer !== undefined) window.clearTimeout(record.timer)
    record.controller?.abort()
    record.timer = undefined
    record.controller = undefined
    return record
  }

  async function execute(
    connection: ModelConnection,
    credential: string | null,
    record: LifecycleRecord,
    sequence: number,
  ): Promise<void> {
    if (lifecycles.current.get(connection.id) !== record || record.sequence !== sequence) return
    record.timer = undefined
    const controller = new AbortController()
    record.controller = controller
    setProbes((current) => ({ ...current, [connection.id]: { phase: 'checking' } }))
    try {
      const result = await probeModelConnection(connection, {
        ...(typeof credential === 'string' ? { credential } : {}),
        signal: controller.signal,
      })
      if (
        lifecycles.current.get(connection.id) === record &&
        record.sequence === sequence &&
        record.controller === controller
      ) {
        record.controller = undefined
        setProbes((current) => ({ ...current, [connection.id]: { phase: 'done', result } }))
      }
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        lifecycles.current.get(connection.id) === record &&
        record.sequence === sequence &&
        record.controller === controller
      ) {
        record.controller = undefined
        setProbes((current) => ({
          ...current,
          [connection.id]: { phase: 'error', message: apiErrorText(cause) },
        }))
      }
    }
  }

  const idle = (connectionId: string) => setProbes((current) => ({ ...current, [connectionId]: { phase: 'idle' } }))

  function schedule(connection: ModelConnection, credential: string | null | undefined): void {
    const record = supersede(connection.id)
    if (credential === undefined || !canProbe(connection, credential)) {
      idle(connection.id)
      return
    }
    const sequence = record.sequence
    record.timer = window.setTimeout(() => void execute(connection, credential, record, sequence), 500)
  }

  function refresh(connection: ModelConnection, credential: string | null | undefined): void {
    const record = supersede(connection.id)
    if (credential === undefined || !canProbe(connection, credential)) {
      idle(connection.id)
      return
    }
    void execute(connection, credential, record, record.sequence)
  }

  /** The page's opening check: probes every entry once, now. An entry without a credential it may carry
   *  (`undefined`) is not probed. */
  function refreshAll(entries: readonly { connection: ModelConnection; credential: string | null | undefined }[]): void {
    for (const { connection, credential } of entries) refresh(connection, credential)
  }

  /** Supersedes the connection's scheduled or running probe without scheduling another; its result is gone. */
  function cancel(connectionId: string): void {
    supersede(connectionId)
    idle(connectionId)
  }

  function dispose(connectionId: string): void {
    supersede(connectionId)
    lifecycles.current.delete(connectionId)
    setProbes((current) => {
      if (!Object.hasOwn(current, connectionId)) return current
      const next = { ...current }
      delete next[connectionId]
      return next
    })
  }

  useEffect(() => {
    const active = lifecycles.current
    return () => {
      for (const { timer, controller } of active.values()) {
        if (timer !== undefined) window.clearTimeout(timer)
        controller?.abort()
      }
      active.clear()
    }
  }, [])

  return { probes, schedule, refreshAll, cancel, dispose }
}
