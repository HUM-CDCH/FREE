/** Runnable checks of adapters against a real canonical document; no model calls. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { batchAccounting, hash, identifySlices, nativeResponse, replayResponse, retrievalCandidates } from './run.js'
import { decodeParsedDocument } from '../../../../../packages/extraction/src/parsed-document.js'
import { sourceContext } from '../../../../../packages/extraction/src/source-context.js'
import { schemas, policy } from './schemas.js'

const root = fileURLToPath(new URL('../../../../../artifacts/catalog-lab/models-policy-v2', import.meta.url))
assert.deepEqual(JSON.parse(await readFile(`${root}/schemas.json`, 'utf8')), { schemas, policy })
const document = decodeParsedDocument(JSON.parse(await readFile(`${root}/inputs/beier/baseline/parsed_document.json`, 'utf8')))
const images = JSON.parse(await readFile(`${root}/inputs/beier/images.json`, 'utf8'))
const slices = [{ id: 'one', text: 'alpha' }, { id: 'two', text: 'beta' }]
const batch = '### Record R1\nalpha\n\n### Record R2\nbeta'
assert.deepEqual(identifySlices(batch, slices), ['one', 'two'])
assert.deepEqual(identifySlices('beta', slices), ['two'])
assert.throws(() => identifySlices('unknown', slices))
const attempted = new Set<string>()
assert.deepEqual(batchAccounting('beta', false, attempted), { records: 1, fallback: false })
assert.deepEqual(batchAccounting(batch, true, attempted), { records: 2, fallback: false })
assert.deepEqual(batchAccounting('beta', false, attempted), { records: 1, fallback: true })
const fields = [{ id: 'record_id', name: 'record_id', type: 'verbatim-string' as const }]
const response = nativeResponse({ records: [{ __record_id: 'string', record_id: 'verbatim-string' }] }, fields, ['two', 'one'],
  { one: { values: { record_id: 'source-1' } }, two: { values: { record_id: 'source-2' } } })
assert.deepEqual(response, { records: [{ __record_id: 'R1', record_id: 'source-2' }, { __record_id: 'R2', record_id: 'source-1' }] })
assert.throws(() => nativeResponse({ records: [{ record_id: 'string' }] }, fields, ['one'], { one: { values: {} } }))
const request = { template: { record: { record_id: 'verbatim-string' } }, markdown: 'alpha' }
const saved = { index: 1, phase: 'values' as const, request, requestHash: hash(request), origin: 'fresh' as const, status: 'succeeded' as const,
  durationMs: 10, response: { result: { record: { record_id: 'source-1' } }, metadata: { finishReason: 'stop', inputTokens: 1, outputTokens: 1, durationMs: 10 } } }
assert.deepEqual(replayResponse(saved, 'values', hash(request)), saved.response)
assert.throws(() => replayResponse(saved, 'values', hash({ ...request, markdown: 'changed' })))
assert.throws(() => replayResponse(saved, 'discovery', hash(request)))
const context = sourceContext(document)
const boundaries = [15,18].map((start, index) => ({ startBlockId: document.content_stream[start].block_id,
  startContentIndex: start, endContentIndex: index ? 22 : 18, headingText: '', headingLevel: null }))
const anchors = Object.fromEntries([...context.anchorIdByLabel].map(([label, id]) => [label, context.textByAnchorId.get(id)!]))
const selected = retrievalCandidates({ claims: { C1: 'Augsdorf', C2: 'Augsdorf' }, anchors,
  claimFields: { C1: { record: 'records[0]', field: 'locality', description: null }, C2: { record: 'records[1]', field: 'locality', description: null } } },
  document, boundaries, [{ id: 'locality', name: 'locality', type: 'verbatim-string' }], images,
  { '1:C1': images.map((i: { id: string }) => i.id), '1:C2': images.map((i: { id: string }) => i.id) }, 1)
assert(selected.allowed.C1.length > 0 && selected.allowed.C2.length > 0)
assert(selected.allowed.C1.every(label => !selected.allowed.C2.includes(label)))
const missed = retrievalCandidates({ claims: { C1: 'Augsdorf' }, anchors,
  claimFields: { C1: { record: 'records[0]', field: 'locality', description: null } } }, document, boundaries, [], images,
  { '1:C1': ['p3-c4'] }, 1)
assert.equal(missed.allowed.C1.length, 0)
console.log('PASS: record identity, actual fallback accounting, routing-key collision, replay matching, top-three same-record candidates, no silent retrieval fallback')
