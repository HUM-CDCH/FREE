import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { ParsedDocument } from 'extraction/parsed-document'
import { canonicalSource } from 'extraction/source-context'
import { templateFromSchema, wrapTemplate, unwrapQuotes, validateTyped, mappedCanonicalSource, mapQuotes, validateCompletion, postJson } from './quote-extraction.mts'

test('quote schema preserves typed leaves, scalar arrays and original result paths', () => {
  const template = templateFromSchema('{"records":[{"id":"string","depth":0.0,"count":0,"found":true,"dates":["1900-01-01"]}]}')
  assert.deepEqual(template, { records: [{ id: 'string', depth: 'number', count: 'integer', found: 'boolean', dates: ['date'] }] })
  const value = { records: [{ id: { value: '12a', evidenceQuote: 'Grab 12a' }, depth: { value: 1.2, evidenceQuote: '1.2 m' }, count: { value: null, evidenceQuote: null }, found: { value: true, evidenceQuote: null }, dates: [{ value: '1900-01-01', evidenceQuote: null }] }] }
  const unwrapped = unwrapQuotes(value, template)
  assert.deepEqual(unwrapped.result, { records: [{ id: '12a', depth: 1.2, count: null, found: true, dates: ['1900-01-01'] }] })
  assert.deepEqual(unwrapped.quotes.at(-1)?.resultPath, ['records', 0, 'dates', 0])
  validateTyped(value, wrapTemplate(template))
  assert.throws(() => validateTyped({ records: [{ id: 12 }] }, template), /Invalid typed/)
  assert.throws(() => validateTyped('1.2', 'number'), /Invalid typed/)
  assert.throws(() => validateTyped('2026-02-30', 'date'), /Invalid typed/)
  assert.throws(() => validateTyped({ value: 'x', evidenceQuote: 1 }, wrapTemplate('string')), /Invalid typed/)
})

test('quote mapping retains occurrences, cross-anchor sets, whitespace and suffixes', () => {
  const source = { text: 'Grab 12a\n  Tiefe 1,2 m\nGrab 12a', spans: [{ anchorId: 'a', start: 0, end: 8 }, { anchorId: 'b', start: 11, end: 22 }, { anchorId: 'c', start: 23, end: 31 }] }
  // Use observed text positions, not hard-coded guessed offsets.
  source.spans = ['Grab 12a', 'Tiefe 1,2 m', 'Grab 12a'].map((text, i) => {
    const start = i === 2 ? source.text.lastIndexOf(text) : source.text.indexOf(text)
    return { anchorId: ['a', 'b', 'c'][i], start, end: start + text.length }
  })
  const mapped = mapQuotes(source, ['Grab 12a', 'Grab 12a Tiefe 1,2 m', 'Grab 12b', 'Tiefe 1.2 m', null].map((evidenceQuote, i) => ({ resultPath: [i], value: 'x', evidenceQuote })))
  assert.equal(mapped[0].status, 'ambiguous')
  assert.deepEqual(mapped[0].proposedAnchorSets, [['a'], ['c']])
  assert.deepEqual(mapped[1].proposedAnchorSets, [['a', 'b']])
  assert.equal(mapped[2].status, 'not_found')
  assert.equal(mapped[3].status, 'not_found')
  assert.equal(mapped[4].status, 'missing')
})

test('canonical source offsets preserve table delimiters and reject fabricated concatenation', () => {
  const document = { pages: [{ page_number: 1, ordered_content: ['p', 't'], unplaced_content: [] }, { page_number: 2, ordered_content: ['q'], unplaced_content: [] }],
    content_stream: [{ block_id: 'p', kind: 'paragraph', text: 'Alpha' }, { block_id: 't', kind: 'table', table_id: 'table' }, { block_id: 'q', kind: 'paragraph', text: 'Omega' }],
    tables: [{ table_id: 'table', cells: [{ row: 0, column: 0, text: '12a', evidence_anchor_id: 'cell-a' }, { row: 0, column: 1, text: '2 cm', evidence_anchor_id: 'cell-b' }] }],
    evidence_index: { anchors: [{ kind: 'text', block_id: 'p', anchor_id: 'a' }, { kind: 'text', block_id: 'q', anchor_id: 'b' }] } } as unknown as ParsedDocument
  const source = mappedCanonicalSource(document)
  assert.equal(source.text, canonicalSource(document))
  for (const span of source.spans) assert.ok(source.text.slice(span.start, span.end).length)
  const results = mapQuotes(source, ['12a | 2 cm', '12a 2 cm', '2 cm ## Page 2 Omega', '## Page 1'].map((evidenceQuote) => ({ resultPath: [], value: 1, evidenceQuote })))
  assert.deepEqual(results[0].proposedAnchorSets, [['cell-a', 'cell-b']])
  assert.equal(results[1].status, 'not_found')
  assert.equal(results[2].status, 'mapping_failure')
  assert.equal(results[3].status, 'mapping_failure')
})

test('incomplete or usage-less generations cannot enter evaluation', () => {
  validateCompletion({ done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10 }, 20)
  for (const body of [{ done: true, done_reason: 'length', prompt_eval_count: 100, eval_count: 10 }, { done: false, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10 }, { done: true, done_reason: 'stop' }, { done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 20 }]) assert.throws(() => validateCompletion(body, 20))
})

test('model transport preserves request and non-success response for the audit', async () => {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).truncate, false)
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end('{"error":"input exceeds context"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const result = await postJson(`http://127.0.0.1:${address.port}/api/chat`, { truncate: false })
    assert.equal(result.status, 400)
    assert.equal(JSON.parse(result.text).error, 'input exceeds context')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('fresh preparation reads schema and source without claims or gold labels', () => {
  const root = mkdtempSync(join(tmpdir(), 'grounding-quote-'))
  try {
    const source = join(root, 'source'), output = join(root, 'output')
    mkdirSync(source)
    writeFileSync(join(source, 'parsed_document.json'), readFileSync(new URL('../final_dataset_3/conrad-2011-bbc-graves-de/parsed_document.json', import.meta.url)))
    writeFileSync(join(source, 'schema.json'), '{"title":"string","records":[{"id":"string"}]}')
    const run = spawnSync(process.execPath, ['--experimental-strip-types', new URL('./quote-extraction.mts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--source', source, '--output', output, '--arm', 'quote', '--prepare-only'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(existsSync(join(output, 'request.json')))
    assert.equal(existsSync(join(source, 'claims.json')), false)
    assert.equal(existsSync(join(output, 'extracted_meta.json')), false)
    const request = JSON.parse(readFileSync(join(output, 'request.json'), 'utf8'))
    assert.equal(request.truncate, false)
    assert.equal(request.shift, false)
    assert.equal(request.options.num_ctx, 262144)
    assert.equal(request.options.num_predict, 32768)
    const historical = spawnSync(process.execPath, ['--experimental-strip-types', new URL('./extract-real.mts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), root, '--templates-only'], { encoding: 'utf8' })
    assert.equal(historical.status, 0, historical.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(source, 'template.json'), 'utf8')), { title: 'string', records: [{ id: 'string' }] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
