import { useEffect, useRef, useState } from 'react'
import { isValidApiBase, type CredentialState, type ModelConnection, type ProbeResult, type ProviderDescriptor } from '../../shared/modelConfig.contract'
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
  credentialStates: Readonly<Record<string, CredentialState>>
}

export function useProbeLifecycle({ providers, credentialStates }: ProbeInputs) {
  const [probes, setProbes] = useState<Record<string, ProbeView>>({})
  const lifecycles = useRef(new Map<string, LifecycleRecord>())

  function providerFor(connection: ModelConnection): ProviderDescriptor | undefined {
    return providers.find(({ kind }) => kind === connection.provider)
  }

  function canProbe(connection: ModelConnection, action: string | null | undefined): boolean {
    const provider = providerFor(connection)
    if (!provider || !connection.name.trim()) return false
    if (provider.transport === 'http' && !isValidApiBase(connection.baseUrl)) return false
    if (provider.authentication !== 'managed') return true
    return typeof action === 'string' && action.length > 0
      ? true
      : action === undefined && credentialStates[connection.id] === 'present'
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
    action: string | null | undefined,
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
        ...(action === undefined ? {} : { credential: action }),
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

  function schedule(connection: ModelConnection, action: string | null | undefined): void {
    const record = supersede(connection.id)
    if (!canProbe(connection, action)) {
      setProbes((current) => ({ ...current, [connection.id]: { phase: 'idle' } }))
      return
    }
    const sequence = record.sequence
    record.timer = window.setTimeout(() => void execute(connection, action, record, sequence), 500)
  }

  function refresh(connection: ModelConnection, action: string | null | undefined): void {
    const record = supersede(connection.id)
    if (!canProbe(connection, action)) {
      setProbes((current) => ({ ...current, [connection.id]: { phase: 'idle' } }))
      return
    }
    void execute(connection, action, record, record.sequence)
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

  return { probes, canProbe, schedule, refresh, dispose }
}
