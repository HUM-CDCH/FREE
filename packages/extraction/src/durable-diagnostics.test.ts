import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareDiagnostics, diagnosticOptionsSchema, type ExtractionDiagnostic } from './durable-diagnostics.js'
import { diagnosticArguments, diagnosticOutput, runDiagnosticCli, sanitizeDiagnosticPayload } from './durable-diagnostics-cli.js'

const id = '46e7d07e-05f1-4cfc-8144-a9cfb5d25b41'
const report: ExtractionDiagnostic = { id, status: 'COMPLETED', intent: 'RUN', generation: 1, snapshotVersion: 1,
  source: { revision: id, generation: 'g1' }, schemaDigest: 'schema', methodDigest: 'method', values: 0, records: 0,
  stages: [{ stage: 'discovery', captures: 1, checkpointed: 1 }], sample: { stage: 'discovery', limit: 3, truncated: false },
  calls: [{ id, key: 'unit', generation: 1, inputDigest: 'new', sourceDigest: 'source', systemDigest: 'with-guidance',
    schemaDigest: 'schema', providerDigest: 'provider', optionsDigest: 'options', sourceCharacters: 100, examples: 1, omissions: 0,
    reply: { saved: true, places: 0, ok: true, finish: 'stop', inputTokens: 100, outputTokens: 18 } }] }

test('arguments require an owner, validate identities and bound the sample', () => {
  for (const args of [[], ['--extraction', id], ['--owner', 'private-secret', '--extraction', id],
    ['--owner', id, '--extraction', id, '--limit', '1000'], ['--owner', id, '--extraction', id, '--unknown', 'secret']])
    assert.throws(() => diagnosticArguments(args), error => error instanceof Error && !error.message.includes('private-secret'))
  assert.equal(diagnosticArguments(['--owner', id, '--extraction', id])?.options.stage, 'discovery')
  assert.throws(() => diagnosticOptionsSchema.parse({ owner: id, extraction: id, limit: 0 }))
})

test('comparison distinguishes changed prompt guidance while identifying the same saved source and unit', () => {
  const previous = structuredClone(report)
  previous.calls[0]!.systemDigest = 'without-guidance'
  previous.calls[0]!.inputDigest = 'old'
  previous.calls[0]!.reply.places = 205
  const difference = compareDiagnostics(report, previous)
  assert.equal(difference.sourceChanged, false)
  assert.equal(difference.matchedCalls[0]!.systemChanged, true)
  assert.equal(difference.matchedCalls[0]!.sourceChanged, false)
  assert.deepEqual(difference.matchedCalls[0]!.places, { current: 0, previous: 205 })
})

test('different call keys still expose sampled request differences without inventing matched units', () => {
  const previous = structuredClone(report)
  previous.calls[0]!.key = 'different-frozen-unit'
  previous.calls[0]!.systemDigest = 'without-guidance'
  previous.sample.truncated = true
  const difference = compareDiagnostics(report, previous)
  assert.equal(difference.matchedCalls.length, 0)
  assert.equal(difference.sampledRequests.systemChanged, true)
  assert.equal(difference.sampledRequests.sourceChanged, false)
  assert.equal(difference.sampledRequests.providerChanged, false)
  assert.equal(difference.sampledRequests.complete, false)
})

test('output remains bounded and never implicitly includes payloads', async () => {
  let stdout = '', stderr = ''
  const exit = await runDiagnosticCli(['--owner', id, '--extraction', id], { DATABASE_URL: 'postgresql://fixture:secret@invalid/db' },
    async () => ({ summary: { extraction: report }, payloads: [{ extraction: id, capture: id, inputDigest: 'digest',
      request: 'private-source-canary', output: 'credential-canary' }] }),
    { stdout: text => { stdout += text; return true }, stderr: text => { stderr += text; return true } })
  assert.equal(exit, 0)
  assert.equal(stderr, '')
  assert.ok(!stdout.includes('canary') && !stdout.includes('secret'))
  const large = structuredClone(report)
  large.source.generation = 'x'.repeat(20_000)
  assert.throws(() => diagnosticOutput({ extraction: large }), /too large/)
})

test('database errors cannot disclose credentials, SQL or private source text', async () => {
  let stdout = '', stderr = ''
  assert.equal(await runDiagnosticCli(['--owner', id, '--extraction', id], { DATABASE_URL: 'postgresql://fixture:secret@invalid/db' },
    async () => { throw new Error('password=secret private-source-canary') },
    { stdout: text => { stdout += text; return true }, stderr: text => { stderr += text; return true } }), 1)
  assert.equal(stdout, '')
  assert.ok(!stderr.includes('secret') && !stderr.includes('canary'))
})

test('explicit debug files are private, sanitized and separate from metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-diagnostic-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let stdout = ''
  const request = { body: { user: 'private-source-canary', httpRequest: { headers: { Authorization: 'credential-canary' } } },
    provider: { url: 'https://user:credential-canary@example.invalid/v1?api_key=credential-canary' } }
  const exit = await runDiagnosticCli(['--owner', id, '--extraction', id, '--payload-dir', directory],
    { DATABASE_URL: 'postgresql://fixture@invalid/db' },
    async () => ({ summary: { extraction: report }, payloads: [{ extraction: id, capture: id, inputDigest: 'digest', request, output: null }] }),
    { stdout: text => { stdout += text; return true }, stderr: () => true })
  assert.equal(exit, 0)
  const file = JSON.parse(stdout).payloadFiles[0]
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(join(file, '..'))).mode & 0o777, 0o700)
  assert.ok((await readFile(file, 'utf8')).includes('private-source-canary'))
  assert.ok(!(await readFile(file, 'utf8')).includes('credential-canary'))
  assert.ok(!stdout.includes('canary'))
  assert.deepEqual(sanitizeDiagnosticPayload({ error: 'private' }), { error: '[REDACTED]' })
})
