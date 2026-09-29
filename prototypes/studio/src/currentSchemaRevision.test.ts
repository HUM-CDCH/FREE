import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchemaDefinition, SchemaNode } from 'extraction/schema'
import type {
  SchemaRevision,
  SchemaRevisionSummary,
} from '../shared/schemaRevision.contract'
import { SchemaRevisionConflictError } from './schemaRevisions'
import type { AcknowledgedSchemaRevision, SchemaSaveState } from './schemaSaveCoordinator'
import {
  createSchemaEditorController,
  durableSchemaPersistence,
  localSchemaPersistence,
} from './currentSchemaRevision'

const node = (name: string): SchemaNode => ({
  id: `id-${name}`,
  name,
  type: 'string',
})

const definition = (name: string): SchemaDefinition => ({
  recordDescription: `One ${name} record.`,
  schemaNodes: [node(name)],
})

const revision = (
  revisionNumber: number,
  name: string,
): SchemaRevision => ({
  schemaRevisionId: `rev-${revisionNumber}`,
  extractionSchemaId: 'schema-1',
  revisionNumber,
  origin: 'researcher-edit',
  createdAt: '2026-08-01T12:00:00.000Z',
  recordDescription: `One ${name} record.`,
  schemaNodes: [node(name)],
})

const summaryOf = (
  revisionNumber: number,
  name: string,
): SchemaRevisionSummary => ({
  schemaRevisionId: `rev-${revisionNumber}`,
  extractionSchemaId: 'schema-1',
  revisionNumber,
  origin: 'researcher-edit' as const,
  createdAt: '2026-08-01T12:00:00.000Z',
  summary: name,
})

/** Durable persistence wired to in-memory fakes with an observation harness. */
function setupDurable(options: {
  initial?: AcknowledgedSchemaRevision | null
  debounceMs?: number
  normalizeAcknowledgement?: (definition: SchemaDefinition) => SchemaDefinition
} = {}) {
  const edits: SchemaDefinition[] = []
  const events: string[] = []
  const messages: string[] = []
  const appends: Array<{ expected: number; definition: SchemaDefinition }> = []
  const historyName = (sent: AcknowledgedSchemaRevision): string =>
    sent.recordDescription.replace(/^One | record\.$/g, '')
  const history: SchemaRevisionSummary[] = options.initial
    ? [summaryOf(options.initial.revisionNumber, historyName(options.initial))]
    : []
  let appendResult: SchemaRevision | SchemaRevisionConflictError | Error | null =
    null
  let hold: PromiseWithResolvers<void> | null = null

  const persistence = durableSchemaPersistence({
    projectContextId: 'project-1',
    initial: options.initial ?? null,
    debounceMs: options.debounceMs,
    append: async (_extractionSchemaId, expectedRevisionNumber, sent) => {
      events.push('append')
      appends.push({ expected: expectedRevisionNumber, definition: sent })
      if (hold) {
        await hold.promise
        hold = null
      }
      if (appendResult instanceof SchemaRevisionConflictError) throw appendResult
      if (appendResult instanceof Error) throw appendResult
      const next =
        appendResult ??
        {
          ...revision(expectedRevisionNumber + 1, sent.schemaNodes[0]!.name),
          ...(options.normalizeAcknowledgement?.(sent) ?? sent),
        }
      history.unshift(summaryOf(next.revisionNumber, historyName(next)))
      return next
    },
    initialize: async (sent) => {
      events.push('initialize')
      return revision(1, sent.schemaNodes[0]!.name)
    },
    listRevisions: async () => [...history],
    getRevision: async () => revision(1, 'historical'),
  })


  // Instrument the adapter's surface so tests observe what the core does.
  const rawEdit = persistence.edit.bind(persistence)
  persistence.edit = (sent) => {
    events.push('edit')
    edits.push(sent)
    rawEdit(sent)
  }
  const rawFlush = persistence.flush.bind(persistence)
  persistence.flush = async () => {
    events.push('flush')
    return rawFlush()
  }

  const controller = createSchemaEditorController(persistence, {
    initialDraft: options.initial
      ? {
          recordDescription: options.initial.recordDescription,
          schemaNodes: options.initial.schemaNodes,
        }
      : null,
    initialRevisionNumber: options.initial?.revisionNumber,
    initialExtractableRevisionId: options.initial?.schemaRevisionId ?? null,
    onCommitMessage: (message) => messages.push(message),
  })
  return {
    controller,
    persistence,
    edits,
    events,
    messages,
    appends,
    saveState: (): SchemaSaveState['status'] | null =>
      controller.snapshot().save?.status ?? null,
    failNextAppendWith: (error: SchemaRevisionConflictError | Error) => {
      appendResult = error
    },
    /** The next append waits until the returned function is called. */
    holdNextAppend: () => {
      hold = Promise.withResolvers<void>()
      return () => hold?.resolve()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('editor gate', () => {
  it('rejects duplicate sibling names and reports the offender', () => {
    const { controller } = setupDurable({ initial: revision(1, 'site') })

    const result = controller.commit(
      (current) => [...current, { ...node('site'), id: 'id-other' }],
      '✎ Schema updated',
    )

    expect(result).toEqual({
      ok: false,
      reason: 'duplicate-name',
      duplicateName: 'site',
    })
    expect(controller.snapshot().draft!.schemaNodes).toHaveLength(1)
  })

  it('drops the extractable revision after a valid mutation', () => {
    const setup = setupDurable({ initial: revision(1, 'site') })
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-1')

    const result = setup.controller.commit(
      (current) => [...current, node('year')],
      '✎ Schema updated',
    )

    expect(result).toEqual({ ok: true })
    expect(setup.messages).toEqual(['✎ Schema updated'])
    // The extractable revision drops because the draft has not been acknowledged.
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBeNull()
    expect(setup.saveState()).toBe('dirty')
  })

  it('debounces commits and restores the extractable revision on acknowledgement', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 1500 })
    const commitYear = () =>
      setup.controller.commit((current) => [...current, node('year')], 'edit')

    commitYear()
    await vi.advanceTimersByTimeAsync(100)
    commitYear()
    await vi.advanceTimersByTimeAsync(1500)

    expect(setup.events.filter((event) => event === 'append')).toHaveLength(1)
    expect(setup.appends[0]).toEqual({
      expected: 1,
      definition: {
        recordDescription: 'One site record.',
        schemaNodes: [node('site'), node('year')],
      },
    })
    expect(setup.saveState()).toBe('saved')
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-2')
    expect(setup.controller.snapshot().history[0]?.revisionNumber).toBe(2)
  })

  it('adopts a normalized acknowledgement and restores its extractable revision', async () => {
    const setup = setupDurable({
      initial: revision(1, 'site'),
      debounceMs: 0,
      normalizeAcknowledgement: (sent) => ({
        ...sent,
        recordDescription: sent.recordDescription.trim(),
      }),
    })

    setup.controller.setRecordDescription('One site record. ')
    await vi.advanceTimersByTimeAsync(0)

    expect(setup.saveState()).toBe('saved')
    expect(setup.controller.snapshot().draft?.recordDescription).toBe(
      'One site record.',
    )
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe(
      'rev-2',
    )
  })

  it('reloads the winning revision after a conflict', async () => {
    const setup = setupDurable({
      initial: revision(3, 'latest'),
      debounceMs: 0,
    })
    setup.failNextAppendWith(
      new SchemaRevisionConflictError(revision(7, 'elsewhere')),
    )

    setup.controller.commit((current) => [...current, node('year')], 'edit')
    await vi.advanceTimersByTimeAsync(0)

    expect(setup.saveState()).toBe('conflict')
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBeNull()

    expect(setup.controller.reloadCurrent()?.schemaRevisionId).toBe('rev-7')
    expect(setup.saveState()).toBe('saved')
    expect(setup.controller.snapshot().draft).toEqual(
      definition('elsewhere'),
    )
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe(
      'rev-7',
    )
  })

  it('replaceDraft adopts trusted definitions without the duplicate gate', () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })

    setup.controller.replaceDraft(definition('replaced'), 'via JSON')

    expect(setup.controller.snapshot().draft).toEqual({
      ...definition('replaced'),
      schemaNodes: [node('replaced')],
    })
  })

  it('setRecordDescription is a no-op when nothing changed', () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })

    setup.controller.setRecordDescription('One site record.')

    expect(setup.edits).toHaveLength(0)
    expect(setup.messages).toHaveLength(0)
  })

  it('distinguishes a missing draft from a duplicate-name rejection', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })
    await setup.controller.reset()

    expect(
      setup.controller.commit((current) => current, 'unreachable edit'),
    ).toEqual({ ok: false, reason: 'no-draft' })
    expect(setup.controller.clearDraft('unreachable clear')).toEqual({
      ok: false,
      reason: 'no-draft',
    })
  })
})

describe('flush-before-extract', () => {
  it('resolves flush only after the pending append acknowledges', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 60_000 })

    setup.controller.commit((current) => [...current, node('year')], 'edit')
    const flushed = setup.controller.flush()
    let settled = false
    void flushed.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(setup.events).toEqual(['edit', 'flush', 'append'])

    expect(settled).toBe(true)
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-2')
  })

  it('propagates save failures to the flush caller and keeps the editor open', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })
    setup.failNextAppendWith(new Error('Could not save the Current Schema Revision.'))

    setup.controller.commit((current) => [...current, node('year')], 'edit')
    await expect(setup.controller.flush()).rejects.toThrow(
      'Could not save the Current Schema Revision.',
    )
    expect(setup.controller.snapshot().draft!.schemaNodes).toHaveLength(2)
  })
})

const EXCERPTED = { complete: false as const, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] }

describe('generation lifecycle', () => {
  it('initializes a fresh Extraction Schema on first generation', async () => {
    const setup = setupDurable()

    const done = setup.controller.generate(async () => ({
      _description: 'One generated record.',
      place: 'string',
    }))
    expect(setup.controller.snapshot().view).toBe('generating')
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBeNull()
    await done

    expect(setup.events).toContain('initialize')
    expect(setup.controller.snapshot().view).toBe('editing')
    expect(setup.controller.snapshot().extractionSchemaId).toBe('schema-1')
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-1')
    expect(setup.controller.snapshot().draft!.recordDescription).toBe(
      'One generated record.',
    )
  })

  it('joins the existing revision chain on later generations', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })

    await setup.controller.generate(async () => ({
      _description: 'One regenerated record.',
      place: 'string',
    }))

    expect(setup.events).not.toContain('initialize')
    expect(setup.edits).toHaveLength(1)
    expect(setup.controller.snapshot().draft!.recordDescription).toBe(
      'One regenerated record.',
    )
  })

  it('keeps the acknowledged schema mounted and extractable until regeneration is saved', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    let resolveRequest!: (value: unknown) => void
    const request = new Promise<unknown>((resolve) => {
      resolveRequest = resolve
    })

    const generation = setup.controller.generate(() => request)

    expect(setup.controller.snapshot()).toMatchObject({
      view: 'editing',
      generating: true,
      extractableSchemaRevisionId: 'rev-4',
    })
    expect(setup.controller.snapshot().draft).toEqual(definition('site'))

    resolveRequest({
      _description: 'One regenerated record.',
      place: 'string',
    })
    await generation

    expect(setup.controller.snapshot()).toMatchObject({
      view: 'editing',
      generating: false,
      extractableSchemaRevisionId: 'rev-5',
    })
    expect(setup.controller.snapshot().draft?.recordDescription).toBe(
      'One regenerated record.',
    )
  })

  it('reports failures without discarding the previous schema', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })

    await setup.controller.generate(async () => {
      throw new Error('The model refused.')
    })

    expect(setup.controller.snapshot().view).toBe('editing')
    expect(setup.controller.snapshot().generating).toBe(false)
    expect(setup.controller.snapshot().generationError).toBe('The model refused.')
    expect(setup.controller.snapshot().draft!.recordDescription).toBe(
      'One site record.',
    )
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-4')
  })

  it('cancelGeneration returns to the previous view with the draft intact', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    const never = new Promise<unknown>(() => {})
    void setup.controller.generate(() => never)

    setup.controller.cancelGeneration()

    expect(setup.controller.snapshot().view).toBe('editing')
    expect(setup.controller.snapshot().draft!.recordDescription).toBe(
      'One site record.',
    )
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-4')
  })

  it('ignores a late model response after stopping regeneration', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    let resolveRequest!: (value: unknown) => void
    const request = new Promise<unknown>((resolve) => {
      resolveRequest = resolve
    })
    const generation = setup.controller.generate(() => request)

    setup.controller.cancelGeneration()
    resolveRequest({
      _description: 'One late record.',
      late: 'string',
    })
    await generation

    expect(setup.edits).toHaveLength(0)
    expect(setup.controller.snapshot()).toMatchObject({
      view: 'editing',
      generating: false,
      extractableSchemaRevisionId: 'rev-4',
      draft: definition('site'),
    })
  })

  it('Stop cancels the running generation on the server; unmounting only detaches', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    const cancel = vi.fn(async () => {})
    let first: AbortSignal | undefined
    void setup.controller.generate((signal) => {
      first = signal
      return new Promise<unknown>(() => {})
    }, { cancel })

    setup.controller.cancelGeneration()

    expect(cancel).toHaveBeenCalledOnce()
    expect(first!.aborted).toBe(true)
    expect(setup.controller.snapshot().view).toBe('editing')

    const later = vi.fn(async () => {})
    let second: AbortSignal | undefined
    void setup.controller.generate((signal) => {
      second = signal
      return new Promise<unknown>(() => {})
    }, { cancel: later })

    setup.controller.dispose()

    expect(second!.aborted).toBe(true)
    expect(later).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('a Stop whose server cancel fails says so, and the next generation clears it', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    const cancel = vi.fn(async () => { throw new Error('503') })
    void setup.controller.generate(() => new Promise<unknown>(() => {}), { cancel })

    setup.controller.cancelGeneration()
    await vi.advanceTimersByTimeAsync(0)

    expect(cancel).toHaveBeenCalledOnce()
    expect(setup.controller.snapshot()).toMatchObject({
      view: 'editing', generating: false, generationError: null,
      cancellationError: 'The generation could not be stopped on the server; it may still be running and will show as an earlier request after a reload.',
    })

    void setup.controller.generate(() => new Promise<unknown>(() => {}))
    expect(setup.controller.snapshot().cancellationError).toBeNull()
  })

  it('declares what an excerpted generation did not read until the generated draft is replaced', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    expect(setup.controller.snapshot().sourceCoverage).toBeNull()

    await setup.controller.generate(async (_signal, declareSourceCoverage) => {
      declareSourceCoverage(EXCERPTED)
      return { _description: 'One regenerated record.', place: 'string' }
    })
    expect(setup.controller.snapshot().sourceCoverage).toEqual(EXCERPTED)

    // A failed regeneration leaves the excerpted schema, and its declaration, in place.
    await setup.controller.generate(async () => {
      throw new Error('The model refused.')
    })
    expect(setup.controller.snapshot().sourceCoverage).toEqual(EXCERPTED)

    await setup.controller.generate(async (_signal, declareSourceCoverage) => {
      declareSourceCoverage({ complete: true })
      return { _description: 'One whole-source record.', place: 'string' }
    })
    expect(setup.controller.snapshot().sourceCoverage).toBeNull()

    await setup.controller.generate(async (_signal, declareSourceCoverage) => {
      declareSourceCoverage(EXCERPTED)
      return { _description: 'One regenerated record.', place: 'string' }
    })
    await setup.controller.reset()
    expect(setup.controller.snapshot().sourceCoverage).toBeNull()
  })

  it('drops the declaration when a regeneration save conflict adopts a competing revision, and keeps it through a failure', async () => {
    const setup = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    await setup.controller.generate(async (_signal, declareSourceCoverage) => {
      declareSourceCoverage(EXCERPTED)
      return { _description: 'One regenerated record.', place: 'string' }
    })
    expect(setup.controller.snapshot().sourceCoverage).toEqual(EXCERPTED)

    // A model failure leaves the excerpt-generated draft in place, with its declaration.
    await setup.controller.generate(async () => {
      throw new Error('The model refused.')
    })
    expect(setup.controller.snapshot().draft!.recordDescription).toBe('One regenerated record.')
    expect(setup.controller.snapshot().sourceCoverage).toEqual(EXCERPTED)

    // Another tab saved a revision; this tab's next regeneration conflicts, and recovery adopts that revision.
    setup.failNextAppendWith(new SchemaRevisionConflictError(revision(7, 'elsewhere')))
    await setup.controller.generate(async (_signal, declareSourceCoverage) => {
      declareSourceCoverage(EXCERPTED)
      return { _description: 'One late record.', late: 'string' }
    })
    expect(setup.controller.snapshot().generationError).not.toBeNull()
    expect(setup.controller.snapshot().draft).toEqual(definition('elsewhere'))
    expect(setup.controller.snapshot().sourceCoverage).toBeNull()
  })

  it('restoreGeneration carries the declaration of the generation it saves', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })

    await setup.controller.restoreGeneration({ _description: 'One restored record.', restored: 'string' }, 'rev-1', EXCERPTED)

    expect(setup.controller.snapshot().sourceCoverage).toEqual(EXCERPTED)
  })

  it('restoreGeneration saves onto a clean base and drops on a conflict without an error', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })

    await expect(setup.controller.restoreGeneration({ _description: 'One restored record.', restored: 'string' }, 'rev-1')).resolves.toBe(true)

    expect(setup.appends.map((append) => append.expected)).toEqual([1])
    expect(setup.controller.snapshot()).toMatchObject({ view: 'editing', generating: false, generationError: null, extractableSchemaRevisionId: 'rev-2' })
    expect(setup.controller.snapshot().draft!.recordDescription).toBe('One restored record.')

    setup.failNextAppendWith(new SchemaRevisionConflictError(revision(7, 'elsewhere')))
    await expect(setup.controller.restoreGeneration({ _description: 'One late record.', late: 'string' }, 'rev-2')).resolves.toBe(false)

    expect(setup.controller.snapshot().generationError).toBeNull()
    expect(setup.controller.snapshot().draft).toEqual(definition('elsewhere'))
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-7')
    expect(setup.saveState()).toBe('saved')
  })

  it('restoreGeneration keeps edits made meanwhile when the append fails for another reason than a conflict', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })
    const release = setup.holdNextAppend()
    const restore = setup.controller.restoreGeneration({ _description: 'One restored record.', restored: 'string' }, 'rev-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(setup.appends).toHaveLength(1)

    setup.controller.commit((current) => [...current, node('year')], 'edit')
    setup.failNextAppendWith(new Error('network'))
    release()

    await expect(restore).resolves.toBe(false)
    expect(setup.controller.snapshot().draft!.schemaNodes.map((n) => n.name)).toEqual(['site', 'year'])
    expect(setup.controller.snapshot().generationError).toBeNull()
    expect(setup.saveState()).not.toBe('saved')
  })

  it('restoreGeneration refuses a dirty draft, a moved base and a running generation', async () => {
    const dirty = setupDurable({ initial: revision(1, 'site'), debounceMs: 10_000 })
    dirty.controller.commit((current) => [...current, node('year')], 'edit')
    await expect(dirty.controller.restoreGeneration({ _description: 'One record.', a: 'string' }, 'rev-1')).resolves.toBe(false)
    expect(dirty.appends).toHaveLength(0)

    const moved = setupDurable({ initial: revision(4, 'site'), debounceMs: 0 })
    await expect(moved.controller.restoreGeneration({ _description: 'One record.', a: 'string' }, 'rev-3')).resolves.toBe(false)
    expect(moved.appends).toHaveLength(0)
    expect(moved.controller.snapshot().draft).toEqual(definition('site'))

    const running = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })
    void running.controller.generate(() => new Promise<unknown>(() => {}))
    await expect(running.controller.restoreGeneration({ _description: 'One record.', a: 'string' }, 'rev-1')).resolves.toBe(false)
    expect(running.appends).toHaveLength(0)
  })

  it('restoreGeneration initializes the first schema only while none exists', async () => {
    const setup = setupDurable()

    await expect(setup.controller.restoreGeneration({ _description: 'One first record.', place: 'string' }, null)).resolves.toBe(true)

    expect(setup.events).toContain('initialize')
    expect(setup.controller.snapshot()).toMatchObject({ view: 'editing', extractionSchemaId: 'schema-1', extractableSchemaRevisionId: 'rev-1' })
    expect(setup.controller.snapshot().draft!.recordDescription).toBe('One first record.')
    await expect(setup.controller.restoreGeneration({ _description: 'One second record.', place: 'string' }, null)).resolves.toBe(false)
    expect(setup.events.filter((event) => event === 'initialize')).toHaveLength(1)
  })

  it('a surviving tab keeps saving through its acknowledged head, including edits during generation', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })
    const held = Promise.withResolvers<unknown>()
    const generation = setup.controller.generate(() => held.promise)

    setup.controller.commit((current) => [...current, node('year')], 'edit')
    await vi.advanceTimersByTimeAsync(0)
    expect(setup.saveState()).toBe('saved')
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBe('rev-2')

    held.resolve({ _description: 'One generated record.', place: 'string' })
    await generation

    expect(setup.appends.map((append) => append.expected)).toEqual([1, 2])
    expect(setup.saveState()).toBe('saved')
    expect(setup.controller.snapshot()).toMatchObject({ generating: false, generationError: null, extractableSchemaRevisionId: 'rev-3' })
  })

  it('operationScope names the durable project and schema, and is null for a local draft', () => {
    const durable = setupDurable({ initial: revision(1, 'site') })
    expect(durable.controller.operationScope()).toEqual({ projectContextId: 'project-1', extractionSchemaId: 'schema-1' })
    const fresh = setupDurable()
    expect(fresh.controller.operationScope()).toEqual({ projectContextId: 'project-1', extractionSchemaId: null })
    const local = createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} }))
    expect(local.operationScope()).toBeNull()
  })

  it('keeps durable identity when cancelled initialization still acknowledges', async () => {
    let resolveInitialize!: (value: SchemaRevision) => void
    const initialize = vi.fn(
      () =>
        new Promise<SchemaRevision>((resolve) => {
          resolveInitialize = resolve
        }),
    )
    const persistence = durableSchemaPersistence({
      projectContextId: 'project-1',
      initial: null,
      debounceMs: 0,
      append: async (_schemaId, expected, sent) =>
        revision(expected + 1, sent.schemaNodes[0]!.name),
      initialize,
      listRevisions: async () => [],
      getRevision: async () => revision(1, 'site'),
    })
    const controller = createSchemaEditorController(persistence)
    const generation = controller.generate(async () => ({
      _description: 'One generated record.',
      place: 'string',
    }))
    await Promise.resolve()
    await Promise.resolve()
    expect(initialize).toHaveBeenCalledTimes(1)

    controller.cancelGeneration()
    resolveInitialize(revision(1, 'generated'))
    await generation

    expect(controller.snapshot().view).toBe('empty')
    expect(controller.snapshot().extractionSchemaId).toBe('schema-1')

    await controller.generate(async () => ({
      _description: 'One retried record.',
      place: 'string',
    }))
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().view).toBe('editing')
    controller.dispose()
  })

  it('reset returns to the ungenerated view after flushing', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })

    await setup.controller.reset()

    expect(setup.controller.snapshot().view).toBe('empty')
    expect(setup.controller.snapshot().draft).toBeNull()
    expect(setup.controller.snapshot().extractableSchemaRevisionId).toBeNull()
    // The durable schema stays as the save target for the next generation.
    expect(setup.controller.snapshot().extractionSchemaId).toBe('schema-1')
  })

  it('reset refuses to discard the draft when flushing fails', async () => {
    const setup = setupDurable({ initial: revision(1, 'site'), debounceMs: 0 })
    setup.failNextAppendWith(new Error('Save failed'))
    setup.controller.commit((current) => [...current, node('year')], 'edit')

    await expect(setup.controller.reset()).rejects.toThrow('Save failed')
    expect(setup.controller.snapshot().view).toBe('editing')
  })
})

describe('create Current Schema Revision from history', () => {
  it('previews a historical revision without editing or flushing', async () => {
    const setup = setupDurable({
      initial: revision(2, 'current'),
      debounceMs: 0,
    })

    const preview = await setup.controller.previewHistoricalRevision('rev-1')

    expect(preview.recordDescription).toBe('One historical record.')
    expect(setup.events).toEqual([])
    expect(setup.edits).toEqual([])
    expect(setup.controller.snapshot().draft).toEqual(definition('current'))
    expect(setup.controller.snapshot().historicalPreview).toEqual(preview)

    setup.controller.closeHistoricalPreview()
    expect(setup.controller.snapshot().historicalPreview).toBeNull()
    expect(setup.controller.snapshot().draft).toEqual(definition('current'))
  })

  it('loads, flushes before and after, then adopts the historical tree', async () => {
    const setup = setupDurable({
      initial: revision(2, 'current'),
      debounceMs: 0,
    })

    const created =
      await setup.controller.createCurrentRevisionFromHistory('rev-1')

    expect(created.recordDescription).toBe('One historical record.')
    expect(setup.events).toEqual(['flush', 'edit', 'append', 'flush'])
    expect(setup.messages).toEqual(['Created from Schema Revision 1'])
    expect(setup.controller.snapshot().draft!.schemaNodes[0]!.name).toBe(
      'historical',
    )
  })
})

describe('local persistence adapter', () => {
  function setupLocal() {
    const forwarded: SchemaDefinition[] = []
    const persistence = localSchemaPersistence({
      onEdit: (definition) => forwarded.push(definition),
    })
    const controller = createSchemaEditorController(persistence, {
      initialDraft: definition('suggested'),
    })
    return { controller, forwarded }
  }

  it('forwards committed edits and never claims durability', () => {
    const { controller, forwarded } = setupLocal()

    const result = controller.commit(
      (current) => [...current, node('extra')],
      'ignored message',
    )
    expect(forwarded).toEqual([
      {
        recordDescription: 'One suggested record.',
        schemaNodes: [node('suggested'), node('extra')],
      },
    ])
    expect(result).toEqual({ ok: true })
    expect(controller.snapshot().save).toBeNull()
    expect(controller.snapshot().history).toEqual([])
    expect(controller.snapshot().currentRevisionNumber).toBeUndefined()
  })

  it('keeps durable-only capabilities structurally unavailable', async () => {
    const { controller } = setupLocal()

    await expect(controller.requestModelEdit()).resolves.toBeNull()
    await expect(
      controller.previewHistoricalRevision('rev-1'),
    ).rejects.toThrow('Revision history is unavailable for this draft.')
    await expect(
      controller.createCurrentRevisionFromHistory('rev-1'),
    ).rejects.toThrow('Revision history is unavailable for this draft.')
    await expect(controller.flush()).resolves.toBeNull()
    const persistence = localSchemaPersistence({ onEdit: () => {} })
    expect('flush' in persistence).toBe(false)
    expect('getRevision' in persistence).toBe(false)
    expect('initialize' in persistence).toBe(false)
  })

  it('clears through the gate and adopts external drafts without forwarding', () => {
    const { controller, forwarded } = setupLocal()

    expect(controller.clearDraft('Cleared fields')).toEqual({ ok: true })
    expect(forwarded.at(-1)?.schemaNodes).toEqual([])

    controller.adoptDraft(definition('retried'))
    expect(controller.snapshot().draft).toEqual(definition('retried'))
    expect(forwarded).toHaveLength(1)
  })
})

describe('durable persistence adapter', () => {
  it('stays dormant until the first initialize creates the coordinator', async () => {
    const setup = setupDurable()

    expect(setup.controller.snapshot().save).toBeNull()
    expect(await setup.persistence.listRevisions(20)).toEqual([])

    await setup.controller.generate(async () => ({
      _description: 'One generated record.',
      place: 'string',
    }))
    expect(setup.controller.snapshot().save?.status).toBe('saved')
  })

  it('normalizes externally supplied node ids on adoption and historical use', async () => {
    const setup = setupDurable()

    await setup.controller.generate(async () => ({
      _description: 'One duplicated record.',
      place: 'string',
    }))
    setup.controller.replaceDraft(
      {
        recordDescription: 'One duplicated record.',
        schemaNodes: [
          { id: 'same', name: 'a', type: 'string' },
          { id: 'same', name: 'b', type: 'string' },
        ],
      },
      'json',
    )

    const ids = setup.controller.snapshot().draft!.schemaNodes.map(({ id }) => id)
    expect(new Set(ids)).toHaveLength(2)
  })
})
