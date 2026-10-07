import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verificationRecord, publishVerifiedCommit } from './publish-verified-commit.mjs'

const sha = 'a'.repeat(40)
const environment = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev', GITHUB_REPOSITORY: 'HUM-CDCH/FREE',
  GITHUB_SHA: sha, VERIFY_NODE_RESULT: 'success', VERIFY_PYTHON_RESULT: 'success' }

test('failed or pending checks, PR events, another repository and malformed commits cannot publish', () => {
  for (const change of [{ VERIFY_NODE_RESULT: 'failure' }, { VERIFY_PYTHON_RESULT: 'skipped' },
    { VERIFY_PYTHON_RESULT: 'pending' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REPOSITORY: 'other/FREE' }, { GITHUB_SHA: '--option' }]) {
    let called = false
    assert.throws(() => publishVerifiedCommit({ ...environment, ...change }, () => { called = true }))
    assert.equal(called, false)
  }
})

test('publication binds the exact checked-out SHA and both successful jobs', () => {
  const calls = []
  const run = (_command, args) => {
    calls.push(args)
    return { status: args[0] === 'fetch' ? 1 : 0, stdout: args[0] === 'rev-parse' ? `${sha}\n` : '' }
  }
  publishVerifiedCommit(environment, run)
  assert.ok(calls.some(args => args.includes(JSON.stringify(verificationRecord(environment)))))
  assert.deepEqual(calls.at(-1), ['push', 'origin', `refs/tags/free-verified/${sha}`])
  assert.throws(() => publishVerifiedCommit(environment, () => ({ status: 0, stdout: 'b'.repeat(40) })), /Checkout/)
})

test('an existing tag is reused only if its metadata and target match', () => {
  let pushed = false
  const run = (_command, args) => {
    if (args[0] === 'push') pushed = true
    return { status: 0, stdout: args[0] === 'for-each-ref'
      ? JSON.stringify(verificationRecord(environment)) : args[0] === 'rev-parse' ? sha : '' }
  }
  publishVerifiedCommit(environment, run)
  assert.equal(pushed, false)
  assert.throws(() => publishVerifiedCommit(environment, (_command, args) => ({ status: 0,
    stdout: args[0] === 'for-each-ref' ? '{"version":0}' : sha })), /does not match/)
})
