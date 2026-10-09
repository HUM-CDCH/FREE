import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { encodeStorage, decodeStorage } from './storage-text.js'

test('JSONB text round trips through History without interpreting literal escapes or extracted object keys', () => {
  const text = 'cm\0 1; literal \\u0000; λ⁻¹; ~free-jsonb-string-v1~"literal"'
  const request = { provider: { model: 'stub' }, composer: 1, tokenizer: {}, budget: {}, examples: [], omissions: [],
    body: { record: 0, user: text, httpRequest: { messages: [{ role: 'user', content: text }] } } }
  const output = { parsed: { content: text }, calls: [{ raw: text }] }
  const value = { id: 'value', modelValue: text, evidence: [{ producer: { quote: text } }] }
  const history = { captures: [{ request: encodeStorage(request), output: encodeStorage(output) }],
    snapshots: [{ values: encodeStorage([value]) }] }
  assert.deepEqual(decodeStorage(history), { captures: [{ request, output }], snapshots: [{ values: [value] }] })
  const legacy = { parsed: { _freeJsonbStrings: 1, value: '~free-jsonb-string-v1~"literal"' } }
  assert.deepEqual(decodeStorage(legacy), legacy)
  assert.deepEqual(encodeStorage({ text: 'cm⁻¹' }), { text: 'cm⁻¹' })
})

test('Python and Studio use identical stored bytes, including Unicode and colliding-looking source keys', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./testing/storage-text.json', import.meta.url), 'utf8'))
  for (const { original, stored } of fixtures) {
    assert.deepEqual(encodeStorage(original), stored)
    assert.deepEqual(decodeStorage(stored), original)
  }
})

test('corrupt encoding is refused before reading inherited properties or inventing original text', () => {
  assert.throws(() => decodeStorage({ _freeJsonbStrings: { version: 2, strings: [], keys: [] } }), /Unsupported/)
  assert.throws(() => decodeStorage({ _freeJsonbStrings: { version: 1, strings: [['__proto__', 'polluted']], keys: [] } }), /Invalid/)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})
