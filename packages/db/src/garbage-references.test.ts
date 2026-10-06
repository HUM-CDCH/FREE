import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGarbageReferences } from './garbage-references.js'
import type { Database } from './prisma/db.js'

/** Only the two reads `referencedPreprocessIds` makes: every surviving revision and every coordination head. */
function fakeDatabase(revisions: { preprocessId: string }[], heads: { sourcePin: unknown; deleted: boolean }[]) {
  const all = <T>(rows: T[]) => ({ select: () => ({ all: async () => rows }) })
  return { orm: { public: { SourceRepresentationRevision: all(revisions) }, extraction_runtime: { Head: all(heads) } } } as
    unknown as Database
}

test('a durable head pins its source run until the head itself is gone, a tombstoned head included', async () => {
  const references = createGarbageReferences(fakeDatabase(
    [{ preprocessId: 'kei-exp:run-revision:g1' }],
    [
      { sourcePin: { runId: 'run-live', generation: 'g2' }, deleted: false },
      // Tombstoned, its native calls not yet quiescent: collectDeletedDurableGraphs deletes the head only afterwards.
      { sourcePin: { runId: 'run-tombstoned', generation: 'g3' }, deleted: true },
    ],
  ))
  assert.deepEqual([...await references.referencedPreprocessIds()].sort(),
    ['kei-exp:run-live:g2', 'kei-exp:run-revision:g1', 'kei-exp:run-tombstoned:g3'])
})

test('a pin without a run or a generation names no run', async () => {
  const references = createGarbageReferences(fakeDatabase([], [
    { sourcePin: { runId: 'run-only' }, deleted: false },
    { sourcePin: { generation: 'g-only' }, deleted: true },
    { sourcePin: {}, deleted: false },
  ]))
  assert.deepEqual([...await references.referencedPreprocessIds()], [])
})
