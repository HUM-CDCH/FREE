import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cpuRequirements } from './install-python-cpu.mjs'

test('CI runs the existing fast Python tier and verifies both jobs before publishing a release tag', () => {
  const workflow = readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8')
  assert.ok(/^  verify-python:/m.test(workflow), 'Python verification job is required')
  assert.ok(workflow.includes('pnpm --filter parsing-service test'), 'Run the existing fast Python tier')
  assert.ok(workflow.includes('needs: [verify, verify-python]'), 'Release publication requires both jobs')
})

test('CPU setup preserves pinned versions and removes only NVIDIA wheel requirements', () => {
  const input = 'torch==2.14.0\ntorchaudio==2.11.0\ntorchvision==0.29.0\nnvidia-cublas-cu12==12.9\nxgrammar==0.2.7\ntriton==3.7.0\n'
  assert.equal(cpuRequirements(input), input.replace('nvidia-cublas-cu12==12.9\n', ''))
  assert.throws(() => cpuRequirements('torch>=2\n'), /must pin/)
})
