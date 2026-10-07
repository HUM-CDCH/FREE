import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import contract from '../../../prototypes/parsing_service/tests/fixtures/contracts/record-scope.json' with { type: 'json' }
import { ExtractionError } from './errors.js'
import { refuseRecordCardinality, refuseRecordScope, storedRecordScope } from './record-scope.js'
import { RECORD_SCOPES, recordScopeOf, recordScopeSchema, strategyOf, type RecordScope } from './schema.js'
import type { ExtractionStrategy } from './types.js'

const strategies = contract.strategies as Record<ExtractionStrategy, RecordScope>
const serviceStrategies = contract.service_strategies as Record<string, RecordScope>
const strategyOfService = (service: string): ExtractionStrategy =>
  Object.entries(strategies).find(([, scope]) => scope === serviceStrategies[service])![0] as ExtractionStrategy
const refusal = (run: () => void): string | null => {
  try { run() } catch (error) {
    assert.ok(error instanceof ExtractionError, String(error))
    return error.code
  }
  return null
}

describe('record scope contract', () => {
  it('names the same two scopes', () => {
    assert.deepEqual([...RECORD_SCOPES], contract.scopes)
    for (const scope of contract.scopes) assert.equal(recordScopeSchema.parse(scope), scope)
    assert.equal(recordScopeSchema.safeParse('article').success, false)
  })

  it('maps ARTICLE to document and CATALOG to records, both ways', () => {
    for (const [strategy, scope] of Object.entries(strategies)) {
      assert.equal(recordScopeOf(strategy as ExtractionStrategy), scope)
      assert.equal(strategyOf(scope), strategy)
    }
    for (const [service, scope] of Object.entries(serviceStrategies))
      assert.equal(recordScopeOf(strategyOfService(service)), scope)
  })

  it('admits a declared scope only under its own strategy', () => {
    for (const row of contract.requests.filter((request) => request.recordScope !== null)) {
      const code = refusal(() => refuseRecordScope(row.recordScope as RecordScope, strategyOfService(row.options.strategy)))
      assert.equal(code, row.valid ? null : 'record_scope_mismatch', JSON.stringify(row))
      if (!row.valid) assert.ok(Object.hasOwn(contract.admission_refusals, code!))
    }
  })

  it('refuses an undeclared scope: Studio requires a choice where the service would derive one', () => {
    assert.ok(Object.hasOwn(contract.admission_refusals, 'record_scope_required'))
    for (const strategy of ['ARTICLE', 'CATALOG'] as const)
      assert.equal(refusal(() => refuseRecordScope(null, strategy)), 'record_scope_required')
  })

  it('names the subject and both selections in a mismatch', () => {
    assert.throws(() => refuseRecordScope('document', 'CATALOG', 'Schema Revision 3'),
      /^ExtractionError: Schema Revision 3 is saved as Article \(document scope\); it cannot run as Catalog\.$/)
  })

  it('accepts the artifact cardinalities the contract lists, and refuses the others', () => {
    for (const row of contract.artifacts) {
      const code = refusal(() => refuseRecordCardinality(row.recordScope as RecordScope, row.records))
      assert.equal(code, row.accepted ? null : 'invalid_model_output', JSON.stringify(row))
    }
    for (const [scope, { min, max }] of Object.entries(contract.cardinality))
      for (const count of [0, 1, 2, 5])
        assert.equal(refusal(() => refuseRecordCardinality(scope as RecordScope, count)) === null,
          count >= min && (max === null || count <= max), `${scope} ${count}`)
  })

  it('says how many roots came back when a document-scope result has another count', () => {
    assert.throws(() => refuseRecordCardinality('document', 2), /exactly one root record; kei-exp returned 2\./)
  })

  it('reads a stored scope column strictly', () => {
    assert.equal(storedRecordScope(null), null)
    assert.equal(storedRecordScope('records'), 'records')
    assert.equal(refusal(() => storedRecordScope('catalog')), 'invalid_schema_revision')
  })
})
