import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateDiscovery, validateBatch } from './bounded-extraction.mts'
import { MODEL, MODEL_DIGEST } from './quote-extraction.mts'

test('complete source regions preserve overlap and require literal identities', () => {
  const blocks = ['Site A', 'Grab 12a', 'depth 1 m', 'Grab 12b', 'inventory']
  const manifest = validateDiscovery([{ start: 0, end: 3, identityBlock: 1, identityQuote: 'Grab 12a', contextBlocks: [] }, { start: 0, end: 5, identityBlock: 3, identityQuote: 'Grab 12b', contextBlocks: [0] }], blocks)
  assert.deepEqual(manifest.map(r => r.sourceKey), ['R001', 'R002'])
  assert.throws(() => validateDiscovery([{ start: 0, end: 2, identityBlock: 1, identityQuote: 'Grab 12c', contextBlocks: [] }], blocks), /verbatim/)
  assert.throws(() => validateDiscovery([{ start: 0, end: 7, identityBlock: 1, identityQuote: 'Grab 12a', contextBlocks: [] }], blocks), /region/)
  assert.throws(() => validateDiscovery([manifest[0], manifest[0]], blocks), /Duplicate/)
  assert.throws(() => validateDiscovery([manifest[0], { ...manifest[0], end: 5 }], blocks), /Duplicate/)
  assert.throws(() => validateDiscovery([{ ...manifest[0], contextBlocks: [50] }], blocks), /context/)
  validateBatch([{ sourceKey: 'R001', record: {} }, { sourceKey: 'R002', record: {} }], manifest)
  for (const keys of [['R001'], ['R001', 'R001'], ['R002', 'R001'], ['R001', 'R002', 'R003']])
    assert.throws(() => validateBatch(keys.map(sourceKey => ({ sourceKey, record: {} })), manifest), /requested record ID/)
})

test('fresh bounded startup needs no labels and retains incomplete discovery as failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bounded-lab-'))
  const source = join(root, 'source'), output = join(root, 'output')
  mkdirSync(source)
  writeFileSync(join(source, 'parsed_document.json'), readFileSync(new URL('../final_dataset_3/conrad-2011-bbc-graves-de/parsed_document.json', import.meta.url)))
  writeFileSync(join(source, 'schema.json'), '{"title":"string","records":[{"id":"string"}]}')
  const server = createServer((req, res) => {
    req.resume()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/api/version' ? { version: '0.32.14' } : req.url === '/api/tags' ? { models: [{ name: MODEL, digest: MODEL_DIGEST }] } : { done: true, done_reason: 'length', prompt_eval_count: 100, eval_count: 8192, message: { content: '{"records":[' } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const child = spawn(process.execPath, ['--experimental-strip-types', new URL('./bounded-extraction.mts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--source', source, '--output', output], { env: { ...process.env, FREE_LIVE_OLLAMA_URL: `http://127.0.0.1:${address.port}` }, stdio: 'ignore' })
    const [code] = await once(child, 'exit')
    assert.equal(code, 1)
    const workflow = JSON.parse(readFileSync(join(output, 'workflow.json'), 'utf8'))
    assert.equal(workflow.complete, false)
    assert.equal(workflow.calls.length, 1)
    assert.equal(workflow.calls[0].complete, false)
    assert.equal(workflow.calls[0].outputTokens, 8192)
    assert.ok(workflow.durationThroughOutputWriteSeconds > 0)
    assert.ok(existsSync(join(output, 'discovery.response.txt')))
    assert.equal(existsSync(join(source, 'claims.json')), false)
    assert.equal(existsSync(join(output, 'record-manifest.json')), false)
  } finally { server.close(); rmSync(root, { recursive: true, force: true }) }
})
