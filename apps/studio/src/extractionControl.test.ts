import { expect, it } from 'vitest'
import { continuation } from './extractionControl'
import type { DurableReading } from './durableReader'

const revisions = [{ schemaRevisionId: 'old', revisionNumber: 9, recordScope: 'records' },
  { schemaRevisionId: 'pending', revisionNumber: 14, recordScope: 'records' }]

it('waits for pending inputs to be applied or discarded before continuing, then names the saved inputs', () => {
  const state = { selection: { schemaRevisionId: 'old' }, pendingSelection: { schemaRevisionId: 'pending' }, schemaRevisions: revisions } as unknown as DurableReading['state']
  expect(continuation(state)).toEqual({ blocked: 'Apply or discard the pending inputs (schema revision 14 (Catalog)) before continuing.',
    description: 'Apply or discard the pending inputs (schema revision 14 (Catalog)) before continuing.' })
  const settled = { ...state!, pendingSelection: null } as unknown as DurableReading['state']
  expect(continuation(settled).blocked).toBeNull()
  expect(continuation(settled).description).toContain('schema revision 9 (Catalog)')
  expect(continuation(null)).toEqual({ blocked: null, description: 'Continue this extraction with its saved inputs.' })
})
