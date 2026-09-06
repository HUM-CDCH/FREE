import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverDiagnostic } from './diagnostic-output.mts'

test('over-limit diagnostic retains every typed value and rejects all other failures', () => {
  const meta = { complete: false, error: 'Error: Result exceeds 20 burial records', arm: 'quote', outputTokens: 32768, context: 262144 }
  const template = { records: [{ id: 'string' }] }
  const content = { records: Array.from({ length: 25 }, (_, i) => ({ id: { value: String(i), evidenceQuote: 'grave' } })) }
  const body = { done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 32490, message: { content: JSON.stringify(content) } }
  const source = { text: 'grave', spans: [{ anchorId: 'a', start: 0, end: 5 }] }
  const result = recoverDiagnostic(meta, body, template, source)
  assert.equal(result.recordCount, 25)
  assert.equal(result.mappings.length, 25)
  assert.deepEqual((result.result as any).records[24], { id: '24' })
  assert.equal(meta.complete, false)
  assert.throws(() => recoverDiagnostic({ ...meta, error: 'TypeError: fetch failed' }, body, template, source))
  assert.throws(() => recoverDiagnostic(meta, { ...body, done_reason: 'length' }, template, source))
  assert.throws(() => recoverDiagnostic(meta, { ...body, eval_count: 32768 }, template, source))
  assert.throws(() => recoverDiagnostic({ ...meta, outputTokens: undefined }, body, template, source))
  const wrongType = { ...body, message: { content: JSON.stringify({ records: [{ id: { value: 1, evidenceQuote: 'grave' } }] }) } }
  assert.throws(() => recoverDiagnostic(meta, wrongType, template, source))
})
