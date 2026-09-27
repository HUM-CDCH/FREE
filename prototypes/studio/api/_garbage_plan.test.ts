import type { CanonicalPackageDescriptor, ScopeSnapshot } from 'db'
import { keiDeleteRunsInputSchema } from 'extraction/kei-handoff'
import { describe, expect, it } from 'vitest'
import {
  GC_POLICY,
  keiParentOf,
  planCancellationRepair,
  planKeiCleanup,
  planPackages,
  planStagedSources,
  planStudioHistory,
  quiescent,
  scopeIdsOf,
  type WorkflowRow,
} from './_garbage_plan'
import type { StagedSource } from './_source_inbox'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const BOOT = 1_000_000_000_000
const NOW = BOOT + 40 * DAY

/** A canonical lowercase UUID made of one repeated hex digit. */
const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
const PROJECT = uuid('1')
const DOCUMENT = uuid('2')
const REVISION = uuid('3')
const SCHEMA = uuid('4')
const SCOPE = {
  projectContextId: PROJECT,
  sourceDocumentId: DOCUMENT,
  sourceRepresentationRevisionId: REVISION,
  extractionSchemaId: SCHEMA,
}

function row(
  workflowID: string,
  status: string,
  extra: Partial<Pick<WorkflowRow, 'updatedAt' | 'completedAt' | 'attributes' | 'output'>> = {},
): WorkflowRow {
  return { workflowID, status, ...extra }
}

function scopes(
  input: {
    projects?: readonly string[]
    documents?: readonly string[]
    revisions?: readonly string[]
    schemas?: readonly string[]
    suggestions?: Readonly<Record<string, { attempt: number; settled: boolean }>>
    extractions?: Readonly<Record<string, { settled: boolean }>>
  } = {},
): ScopeSnapshot {
  return {
    projectContexts: new Set(input.projects ?? []),
    sourceDocuments: new Set(input.documents ?? []),
    sourceRepresentationRevisions: new Set(input.revisions ?? []),
    extractionSchemas: new Set(input.schemas ?? []),
    suggestions: new Map(Object.entries(input.suggestions ?? {})),
    extractions: new Map(Object.entries(input.extractions ?? {})),
  }
}

const EVERY_SCOPE = { projects: [PROJECT], documents: [DOCUMENT], revisions: [REVISION], schemas: [SCHEMA] }

const byId = (...rows: WorkflowRow[]) => new Map(rows.map((entry) => [entry.workflowID, entry]))

describe('rules shared by every plan', () => {
  it('a workflow is quiescent when absent, ended, or stopped before this boot', () => {
    expect(quiescent(undefined, BOOT)).toBe(true)
    expect(quiescent(row('extract:x', 'SUCCESS'), BOOT)).toBe(true)
    expect(quiescent(row('extract:x', 'ERROR'), BOOT)).toBe(true)
    for (const status of ['CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']) {
      expect(quiescent(row('extract:x', status, { updatedAt: BOOT - 1 }), BOOT)).toBe(true)
      expect(quiescent(row('extract:x', status, { updatedAt: BOOT }), BOOT)).toBe(false)
      expect(quiescent(row('extract:x', status, { updatedAt: BOOT + 1 }), BOOT)).toBe(false)
      expect(quiescent(row('extract:x', status), BOOT)).toBe(false)
    }
    for (const status of ['ENQUEUED', 'DELAYED', 'PENDING', 'SOMETHING_NEW'])
      expect(quiescent(row('extract:x', status, { updatedAt: BOOT - 1 }), BOOT)).toBe(false)
  })

  it('maps kei-extract and kei-convert IDs to their Studio parents and nothing else', () => {
    expect(keiParentOf('kei-extract:x')).toBe('extract:x')
    expect(keiParentOf('kei-convert:ingest:p:a')).toBe('ingest:p:a')
    expect(keiParentOf('kei-convert:reprocess:d:k')).toBe('reprocess:d:k')
    expect(keiParentOf('kei-convert:')).toBeNull()
    expect(keiParentOf('kei-gc:t')).toBeNull()
    expect(keiParentOf('other')).toBeNull()
  })

  it('collects every scope an attribute or a workflow ID names', () => {
    expect(
      scopeIdsOf([
        row('extract:e1', 'PENDING'),
        row('suggest:s1:3', 'PENDING'),
        row('edit:o1', 'SUCCESS'),
        row('ingest:p1:a', 'SUCCESS', {
          attributes: {
            projectContextId: 'p1',
            sourceDocumentId: 'd1',
            sourceRepresentationRevisionId: 'r1',
            extractionSchemaId: 'x1',
            batchSchemaSuggestionId: 's2',
          },
        }),
        row('suggestion:q', 'SUCCESS', { attributes: { projectContextId: 'p1', extractionSchemaId: null } }),
      ]),
    ).toEqual({
      projectContextIds: ['p1'],
      sourceDocumentIds: ['d1'],
      sourceRepresentationRevisionIds: ['r1'],
      extractionSchemaIds: ['x1'],
      batchSchemaSuggestionIds: ['s1', 's2'],
      extractionIds: ['e1'],
    })
  })
})

describe('cancellation repair', () => {
  const repair = (liveStudio: WorkflowRow[], snapshot: ScopeSnapshot, liveKei: WorkflowRow[] = [],
    parents: ReadonlyMap<string, WorkflowRow> = new Map()) =>
    planCancellationRepair({ liveStudio, liveKei, parents, scopes: snapshot })

  it('cancels a live runExtraction whose Extraction has an outcome or no longer exists', () => {
    const [settled, gone, open] = [uuid('a'), uuid('b'), uuid('c')]
    const plan = repair(
      [settled, gone, open].map((id) => row(`extract:${id}`, 'PENDING', { attributes: SCOPE })),
      scopes({ ...EVERY_SCOPE, extractions: { [settled]: { settled: true }, [open]: { settled: false } } }),
    )
    expect(plan).toEqual({ studio: [`extract:${settled}`, `extract:${gone}`], kei: [] })
  })

  it('cancels a live suggestion attempt that is settled, superseded by a later attempt, or deleted', () => {
    const [superseded, settled, deleted, current] = [uuid('a'), uuid('b'), uuid('c'), uuid('d')]
    const plan = repair(
      [superseded, settled, deleted, current].map((id) => row(`suggest:${id}:2`, 'ENQUEUED', { attributes: SCOPE })),
      scopes({
        ...EVERY_SCOPE,
        suggestions: {
          [superseded]: { attempt: 3, settled: false },
          [settled]: { attempt: 2, settled: true },
          [current]: { attempt: 2, settled: false },
        },
      }),
    )
    expect(plan.studio).toEqual([`suggest:${superseded}:2`, `suggest:${settled}:2`, `suggest:${deleted}:2`].sort())
  })

  it("cancels live workflow-first work only when its scope is gone; a first generation's null schema names no scope", () => {
    const live = [
      row(`ingest:${PROJECT}:${uuid('a')}`, 'PENDING', { attributes: SCOPE }),
      row(`reprocess:${DOCUMENT}:${uuid('b')}`, 'PENDING', { attributes: SCOPE }),
      row(`suggestion:${uuid('c')}`, 'PENDING', { attributes: SCOPE }),
      row(`edit:${uuid('d')}`, 'DELAYED', { attributes: SCOPE }),
    ]
    const firstGeneration = row(`suggestion:${uuid('e')}`, 'PENDING', { attributes: { ...SCOPE, extractionSchemaId: null } })
    const rows = [...live, firstGeneration]
    const ids = (entries: WorkflowRow[]) => entries.map((entry) => entry.workflowID).sort()

    expect(repair(rows, scopes(EVERY_SCOPE)).studio).toEqual([])
    expect(repair(rows, scopes({ ...EVERY_SCOPE, projects: [] })).studio).toEqual(ids(rows))
    expect(repair(rows, scopes({ ...EVERY_SCOPE, documents: [] })).studio).toEqual(ids(rows))
    expect(repair(rows, scopes({ ...EVERY_SCOPE, revisions: [] })).studio).toEqual(ids(rows))
    expect(repair(rows, scopes({ ...EVERY_SCOPE, schemas: [] })).studio).toEqual(ids(live))
  })

  it('cancels a live kei child whose parent is terminal, absent, or cancelled in this sweep', () => {
    const [stopping, open] = [uuid('a'), uuid('b')]
    const [ended, absent, cancelled, running] = [uuid('c'), uuid('d'), uuid('e'), uuid('f')]
    const plan = repair(
      [row(`extract:${stopping}`, 'PENDING', { attributes: SCOPE }), row(`extract:${open}`, 'PENDING', { attributes: SCOPE })],
      scopes({ ...EVERY_SCOPE, extractions: { [stopping]: { settled: true }, [open]: { settled: false } } }),
      [
        row(`kei-extract:${stopping}`, 'PENDING'),
        row(`kei-extract:${open}`, 'PENDING'),
        row(`kei-convert:ingest:${PROJECT}:${ended}`, 'ENQUEUED'),
        row(`kei-convert:ingest:${PROJECT}:${absent}`, 'PENDING'),
        row(`kei-convert:ingest:${PROJECT}:${cancelled}`, 'PENDING'),
        row(`kei-convert:reprocess:${DOCUMENT}:${running}`, 'PENDING'),
        row('kei-gc:2026-09-26T10:00:00.000Z', 'PENDING'),
      ],
      byId(
        row(`ingest:${PROJECT}:${ended}`, 'ERROR'),
        row(`ingest:${PROJECT}:${cancelled}`, 'CANCELLED', { updatedAt: BOOT + 1 }),
        row(`reprocess:${DOCUMENT}:${running}`, 'PENDING'),
      ),
    )
    expect(plan).toEqual({
      studio: [`extract:${stopping}`],
      kei: [
        `kei-convert:ingest:${PROJECT}:${absent}`,
        `kei-convert:ingest:${PROJECT}:${cancelled}`,
        `kei-convert:ingest:${PROJECT}:${ended}`,
        `kei-extract:${stopping}`,
      ].sort(),
    })
  })

  it('leaves live work alone while its domain row is open and its scope exists', () => {
    const [extraction, suggestion, attempt] = [uuid('a'), uuid('b'), uuid('c')]
    const studio = [
      row(`extract:${extraction}`, 'PENDING', { attributes: SCOPE }),
      row(`suggest:${suggestion}:1`, 'PENDING', { attributes: SCOPE }),
      row(`ingest:${PROJECT}:${attempt}`, 'ENQUEUED', { attributes: { projectContextId: PROJECT } }),
    ]
    expect(
      repair(
        studio,
        scopes({
          ...EVERY_SCOPE,
          extractions: { [extraction]: { settled: false } },
          suggestions: { [suggestion]: { attempt: 1, settled: false } },
        }),
        [row(`kei-extract:${extraction}`, 'PENDING'), row(`kei-convert:ingest:${PROJECT}:${attempt}`, 'PENDING')],
      ),
    ).toEqual({ studio: [], kei: [] })
  })
})

describe('a malformed or missing scope ID never condemns a workflow', () => {
  // The scope read treats any non-canonical ID as absent without querying it, so absence proves nothing about it.
  const upper = PROJECT.replace(/1/g, 'A').toUpperCase()
  const badVersion = `${'1'.repeat(8)}-${'1'.repeat(4)}-9${'1'.repeat(3)}-8${'1'.repeat(3)}-${'1'.repeat(12)}`
  const rows = (status: string, extra: Partial<WorkflowRow>) => [
    row('extract:not-a-uuid', status, extra),
    row(`extract:${uuid('a').toUpperCase()}`, status, extra),
    row('suggest:not-a-uuid:2', status, extra),
    row(`ingest:${upper}:${uuid('b')}`, status, { ...extra, attributes: { projectContextId: upper } }),
    row(`reprocess:x:${uuid('c')}`, status, { ...extra, attributes: { sourceDocumentId: badVersion } }),
    row(`edit:${uuid('d')}`, status, { ...extra, attributes: { projectContextId: 42, extractionSchemaId: 'schema' } }),
    row(`suggestion:${uuid('e')}`, status, extra),
  ]

  it('neither cancels the live workflow nor its kei child', () => {
    const plan = planCancellationRepair({
      liveStudio: rows('PENDING', {}),
      liveKei: [row('kei-extract:not-a-uuid', 'PENDING')],
      parents: new Map(),
      scopes: scopes(),
    })
    expect(plan).toEqual({ studio: [], kei: [] })
  })

  it('deletes its history only once its age allows', () => {
    const plan = (completedAt: number) =>
      planStudioHistory({ rows: rows('SUCCESS', { completedAt }), scopes: scopes(), nowMs: NOW, bootTimestampMs: BOOT, policy: GC_POLICY })
    expect(plan(NOW - HOUR)).toEqual([])
    expect(plan(NOW - 31 * DAY)).toHaveLength(7)
  })

  it("keeps a kei extraction's history while it is young", () => {
    const history = (completedAt: number) =>
      planKeiCleanup({
        kei: [row('kei-extract:not-a-uuid', 'SUCCESS', { completedAt })],
        parents: new Map(),
        runHolders: [],
        referencedPreprocessIds: new Set(),
        extractions: new Map(),
        nowMs: NOW,
        bootTimestampMs: BOOT,
        policy: GC_POLICY,
      })
    expect(history(NOW - HOUR)).toBeNull()
    expect(history(NOW - 31 * DAY)).toEqual({ conversions: [], history: ['kei-extract:not-a-uuid'] })
  })
})

describe('Studio history', () => {
  const history = (rows: WorkflowRow[], snapshot: ScopeSnapshot, options: { bootTimestampMs?: number; policy?: typeof GC_POLICY } = {}) =>
    planStudioHistory({
      rows,
      scopes: snapshot,
      nowMs: NOW,
      bootTimestampMs: options.bootTimestampMs ?? BOOT,
      policy: options.policy ?? GC_POLICY,
    })

  it('deletes settled interactive history after 24 h and background history after 30 days', () => {
    const [young, old] = [uuid('a'), uuid('b')]
    const suggestion = row(`suggestion:${uuid('c')}`, 'SUCCESS', { completedAt: NOW - 25 * HOUR, attributes: SCOPE })
    const edit = row(`edit:${uuid('d')}`, 'ERROR', { completedAt: NOW - 25 * HOUR, attributes: SCOPE })
    const fresh = row(`edit:${uuid('e')}`, 'SUCCESS', { completedAt: NOW - 23 * HOUR, attributes: SCOPE })
    const oldExtract = row(`extract:${old}`, 'SUCCESS', { completedAt: NOW - 31 * DAY, attributes: SCOPE })
    const youngExtract = row(`extract:${young}`, 'SUCCESS', { completedAt: NOW - 25 * HOUR, attributes: SCOPE })
    const deleted = history(
      [suggestion, edit, fresh, oldExtract, youngExtract],
      scopes({ ...EVERY_SCOPE, extractions: { [young]: { settled: true }, [old]: { settled: true } } }),
    )
    expect(deleted.sort()).toEqual([suggestion, edit, oldExtract].map((entry) => entry.workflowID).sort())
  })

  it("deletes a deleted scope's settled history at any age", () => {
    const rows = [
      row(`ingest:${PROJECT}:${uuid('a')}`, 'SUCCESS', { completedAt: NOW - HOUR, attributes: { projectContextId: PROJECT } }),
      row(`extract:${uuid('b')}`, 'ERROR', { completedAt: NOW - HOUR, attributes: SCOPE }),
      row(`suggest:${uuid('c')}:1`, 'SUCCESS', { completedAt: NOW - HOUR, attributes: SCOPE }),
    ]
    expect(history(rows, scopes({ ...EVERY_SCOPE, projects: [] })).sort()).toEqual(rows.map((entry) => entry.workflowID).sort())
    expect(history(rows.slice(1), scopes(EVERY_SCOPE)).sort()).toEqual(rows.slice(1).map((entry) => entry.workflowID).sort())
    expect(history(rows.slice(0, 1), scopes(EVERY_SCOPE))).toEqual([])
  })

  it('keeps history cancelled in this process at any age, even for a deleted scope', () => {
    const cancelled = row(`reprocess:${DOCUMENT}:${uuid('a')}`, 'CANCELLED', {
      updatedAt: BOOT + 1,
      completedAt: NOW - 60 * DAY,
      attributes: SCOPE,
    })
    expect(history([cancelled], scopes())).toEqual([])
  })

  it('deletes history cancelled before this boot once its age or deleted scope allows', () => {
    const old = row(`reprocess:${DOCUMENT}:${uuid('a')}`, 'CANCELLED', {
      updatedAt: BOOT - HOUR,
      completedAt: BOOT - HOUR,
      attributes: SCOPE,
    })
    expect(history([old], scopes(EVERY_SCOPE))).toEqual([old.workflowID])

    const boot = NOW - 2 * HOUR
    const recent = row(`ingest:${PROJECT}:${uuid('b')}`, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', {
      updatedAt: NOW - 3 * HOUR,
      completedAt: NOW - 3 * HOUR,
      attributes: SCOPE,
    })
    expect(history([recent], scopes(EVERY_SCOPE), { bootTimestampMs: boot })).toEqual([])
    expect(history([recent], scopes({ ...EVERY_SCOPE, projects: [] }), { bootTimestampMs: boot })).toEqual([recent.workflowID])
  })

  it("keeps a sweep's own runs for 24 h", () => {
    const old = row('sched-collectGarbage-2026-09-25T09:00:00.000Z', 'SUCCESS', { completedAt: NOW - 25 * HOUR })
    const young = row('sched-collectGarbage-2026-09-26T09:00:00.000Z', 'ERROR', { completedAt: NOW - 23 * HOUR })
    expect(history([old, young], scopes())).toEqual([old.workflowID])
  })

  it('never deletes live history or a workflow it does not own', () => {
    expect(
      history(
        [
          row(`extract:${uuid('a')}`, 'PENDING', { completedAt: NOW - 60 * DAY }),
          row('other:x', 'SUCCESS', { completedAt: NOW - 60 * DAY }),
          row('kei-gc:2026-01-01T00:00:00.000Z', 'SUCCESS', { completedAt: NOW - 60 * DAY }),
        ],
        scopes(),
      ),
    ).toEqual([])
  })

  it('deletes at most the batch size, oldest first', () => {
    const rows = [5, 2, 9, 3].map((days, index) =>
      row(`edit:${uuid(String(index + 5))}`, 'SUCCESS', { completedAt: NOW - days * DAY, attributes: SCOPE }),
    )
    expect(history(rows, scopes(EVERY_SCOPE), { policy: { ...GC_POLICY, historyBatch: 2 } })).toEqual([
      rows[2]!.workflowID,
      rows[0]!.workflowID,
    ])
  })
})

describe('kei runs and history', () => {
  const CONVERSION = `kei-convert:ingest:${PROJECT}:${uuid('a')}`
  const PARENT = `ingest:${PROJECT}:${uuid('a')}`
  const ok = (runId: string) => ({
    ok: true,
    run_id: runId,
    generation: 'g1',
    page_count: 3,
    source_sha256: 'a'.repeat(64),
    page_source: 'pdf',
  })
  const converted = (runId = 'run-1') => row(CONVERSION, 'SUCCESS', { completedAt: NOW - HOUR, output: ok(runId) })
  const cleanup = (input: Partial<Parameters<typeof planKeiCleanup>[0]>) =>
    planKeiCleanup({
      kei: [],
      parents: new Map(),
      runHolders: [],
      referencedPreprocessIds: new Set(),
      extractions: new Map(),
      nowMs: NOW,
      bootTimestampMs: BOOT,
      policy: GC_POLICY,
      ...input,
    })

  it("names a quiescent parent's conversion whose run no revision references", () => {
    expect(cleanup({ kei: [converted()], referencedPreprocessIds: new Set(['kei-exp:run-2:g1', 'other']) })).toEqual({
      conversions: [CONVERSION],
      history: [],
    })
  })

  it('names a failed or cancelled conversion, whose run no revision can reference', () => {
    const failed = row(CONVERSION, 'SUCCESS', {
      completedAt: NOW - HOUR,
      output: { ok: false, code: 'conversion_failed', message: 'The conversion failed.' },
    })
    const cancelled = row(`kei-convert:reprocess:${DOCUMENT}:${uuid('b')}`, 'CANCELLED', { updatedAt: NOW - HOUR })
    expect(cleanup({ kei: [failed, cancelled] })).toEqual({
      conversions: [failed.workflowID, cancelled.workflowID].sort(),
      history: [],
    })
  })

  it('never names a conversion whose run a surviving revision references', () => {
    expect(cleanup({ kei: [converted()], referencedPreprocessIds: new Set(['kei-exp:run-1:g1']) })).toBeNull()
  })

  it("never names a live or unquiesced parent's conversion, even when its run is unreferenced", () => {
    expect(cleanup({ kei: [converted()], parents: byId(row(PARENT, 'PENDING')) })).toBeNull()
    expect(cleanup({ kei: [converted()], parents: byId(row(PARENT, 'CANCELLED', { updatedAt: BOOT + 1 })) })).toBeNull()
    expect(cleanup({ kei: [converted()], parents: byId(row(PARENT, 'CANCELLED', { updatedAt: BOOT - 1 })) })).toEqual({
      conversions: [CONVERSION],
      history: [],
    })
  })

  it('protects a run named by keiRunId of a live extraction or one stopped in this process', () => {
    const holder = (status: string, updatedAt?: number) =>
      row(`extract:${uuid('c')}`, status, { updatedAt, attributes: { ...SCOPE, keiRunId: 'run-1' } })
    expect(cleanup({ kei: [converted()], runHolders: [holder('PENDING')] })).toBeNull()
    expect(cleanup({ kei: [converted()], runHolders: [holder('CANCELLED', BOOT + 5)] })).toBeNull()
    expect(cleanup({ kei: [converted()], runHolders: [holder('CANCELLED', BOOT - 5)] })).toEqual({
      conversions: [CONVERSION],
      history: [],
    })
  })

  it('protects a run while a kei-extract child naming it is live', () => {
    const extraction = uuid('c')
    const child = (status: string) =>
      row(`kei-extract:${extraction}`, status, { completedAt: NOW - HOUR, attributes: { keiRunId: 'run-1' } })
    const parents = byId(row(`extract:${extraction}`, 'PENDING'))
    expect(cleanup({ kei: [converted(), child('PENDING')], parents })).toBeNull()
    expect(cleanup({ kei: [converted(), child('ERROR')], parents })).toEqual({ conversions: [CONVERSION], history: [] })
  })

  it("names a conversion that ended MAX_RECOVERY_ATTEMPTS_EXCEEDED, for kei's own boot boundary to decide", () => {
    expect(cleanup({ kei: [row(CONVERSION, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', { updatedAt: NOW - HOUR })] })).toEqual({
      conversions: [CONVERSION],
      history: [],
    })
  })

  it('names kei-extract history once its parent is quiescent and its Extraction is gone or 30 days old', () => {
    const [gone, kept, old, running] = [uuid('b'), uuid('c'), uuid('d'), uuid('e')]
    const plan = cleanup({
      kei: [
        row(`kei-extract:${gone}`, 'SUCCESS', { completedAt: NOW - HOUR }),
        row(`kei-extract:${kept}`, 'SUCCESS', { completedAt: NOW - HOUR }),
        row(`kei-extract:${old}`, 'ERROR', { completedAt: NOW - 31 * DAY }),
        row(`kei-extract:${running}`, 'SUCCESS', { completedAt: NOW - 31 * DAY }),
      ],
      parents: byId(row(`extract:${kept}`, 'SUCCESS'), row(`extract:${running}`, 'PENDING')),
      extractions: new Map([
        [kept, { settled: true }],
        [old, { settled: true }],
      ]),
    })
    expect(plan).toEqual({ conversions: [], history: [`kei-extract:${gone}`, `kei-extract:${old}`].sort() })
  })

  it('names kei-gc history after 24 h; never names a conversion under history', () => {
    expect(
      cleanup({
        kei: [
          row('kei-gc:2026-09-25T09:00:00.000Z', 'SUCCESS', { completedAt: NOW - 25 * HOUR }),
          row('kei-gc:2026-09-26T09:00:00.000Z', 'SUCCESS', { completedAt: NOW - 23 * HOUR }),
          row('kei-gc:2026-09-26T09:10:00.000Z', 'PENDING'),
        ],
      }),
    ).toEqual({ conversions: [], history: ['kei-gc:2026-09-25T09:00:00.000Z'] })

    // A seeded mix: whatever the plan names, conversions go under conversions, and history is never a conversion.
    let seed = 0x5eed
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)]!
    const statuses = ['ENQUEUED', 'PENDING', 'SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']
    const kei: WorkflowRow[] = []
    const parents = new Map<string, WorkflowRow>()
    for (let index = 0; index < 50; index += 1) {
      const suffix = uuid(pick(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f']))
      const id = pick([`kei-convert:ingest:${PROJECT}:${suffix}`, `kei-convert:reprocess:${DOCUMENT}:${suffix}`,
        `kei-extract:${suffix}`, `kei-gc:${index}`])
      kei.push(row(id, pick(statuses), {
        completedAt: NOW - Math.floor(random() * 60) * DAY,
        output: random() < 0.5 ? ok(`run-${index % 5}`) : { ok: false },
      }))
      const parent = keiParentOf(id)
      if (parent && random() < 0.5) parents.set(parent, row(parent, pick(statuses), { updatedAt: BOOT - 1 }))
    }
    const plan = cleanup({ kei, parents, referencedPreprocessIds: new Set(['kei-exp:run-0:g1']) })
    expect(plan).not.toBeNull()
    expect(plan!.history.length).toBeGreaterThan(0)
    expect(plan!.conversions.length).toBeGreaterThan(0)
    for (const id of plan!.history) expect(id.startsWith('kei-extract:') || id.startsWith('kei-gc:')).toBe(true)
    for (const id of plan!.conversions) expect(id.startsWith('kei-convert:')).toBe(true)
    expect(keiDeleteRunsInputSchema.safeParse(plan).success).toBe(true)
  })

  it('asks for nothing when nothing is due', () => {
    expect(cleanup({})).toBeNull()
    expect(cleanup({ kei: [row(CONVERSION, 'PENDING'), row('kei-gc:x', 'SUCCESS', { completedAt: NOW - HOUR })] })).toBeNull()
  })
})

describe('files', () => {
  const OLD = NOW - 25 * HOUR
  const file = (name: string, modifiedMs: number, workflowId: string | null, temporary = false): StagedSource => ({
    relative: `${PROJECT}/${name}`,
    modifiedMs,
    workflowId,
    temporary,
  })
  const staged = (files: StagedSource[], parents: WorkflowRow[] = [], children: WorkflowRow[] = []) =>
    planStagedSources({ files, parents: byId(...parents), children: byId(...children), nowMs: NOW, policy: GC_POLICY })

  it('removes an old file whose workflow is absent or terminal and whose kei child is not live', () => {
    const [absent, done] = [uuid('a'), uuid('b')]
    const files = [file(`${absent}.pdf`, OLD, `ingest:${PROJECT}:${absent}`), file(`${done}.pdf`, OLD, `ingest:${PROJECT}:${done}`)]
    expect(
      staged(files, [row(`ingest:${PROJECT}:${done}`, 'SUCCESS')], [row(`kei-convert:ingest:${PROJECT}:${done}`, 'SUCCESS')]),
    ).toEqual(files.map((entry) => entry.relative).sort())
  })

  it('keeps a file whose attempt is live, whose kei child is live, or that is younger than 24 h', () => {
    const [recovered, reading, young] = [uuid('a'), uuid('b'), uuid('c')]
    expect(
      staged(
        [
          file(`${recovered}.pdf`, OLD, `ingest:${PROJECT}:${recovered}`),
          file(`${reading}.pdf`, OLD, `ingest:${PROJECT}:${reading}`),
          file(`${young}.pdf`, NOW - 23 * HOUR, `ingest:${PROJECT}:${young}`),
        ],
        [
          row(`ingest:${PROJECT}:${recovered}`, 'PENDING'),
          row(`ingest:${PROJECT}:${reading}`, 'CANCELLED', { updatedAt: BOOT - 1 }),
        ],
        [row(`kei-convert:ingest:${PROJECT}:${reading}`, 'PENDING')],
      ),
    ).toEqual([])
  })

  it('removes an old temporary; keeps a file whose name maps to no workflow', () => {
    const temporary = file(`${uuid('a')}.pdf.${uuid('b')}.tmp`, OLD, null, true)
    expect(
      staged([temporary, file(`${uuid('c')}.pdf.${uuid('d')}.tmp`, NOW - HOUR, null, true), file('notes.txt', OLD, null)]),
    ).toEqual([temporary.relative])
  })

  it('removes old unreferenced packages and old leftovers only, and passes the cutoff for the recheck', () => {
    const descriptor = (name: string): CanonicalPackageDescriptor => ({ artifactReference: name, artifactSha256: 'b'.repeat(64) })
    expect(
      planPackages({
        packages: [
          { descriptor: descriptor('old'), modifiedMs: OLD },
          { descriptor: descriptor('pinned'), modifiedMs: OLD },
          { descriptor: descriptor('recent'), modifiedMs: NOW - 23 * HOUR },
        ],
        leftovers: [
          { name: 'old.tmp', modifiedMs: OLD },
          { name: 'recent.tmp', modifiedMs: NOW - 23 * HOUR },
        ],
        referenced: new Set(['pinned']),
        nowMs: NOW,
        policy: GC_POLICY,
      }),
    ).toEqual({ packages: [descriptor('old')], leftovers: ['old.tmp'], modifiedBeforeMs: NOW - 24 * HOUR })
  })
})
