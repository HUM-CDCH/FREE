import { useEffect, useRef, useState } from 'react'
import { isValidApiBase, type ModelConnection, type ProbeResult, type ProviderDescriptor } from '../../shared/modelConfig.contract'
import { apiErrorText, probeModelConnection } from './providerConfig.data'

export type ProbeView =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; result: ProbeResult }
  | { phase: 'error'; message: string }

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

  return { probes, canProbe, schedule, refresh, cancel, dispose }
}
