import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { installPythonCommand, shouldInstallPython } from './install-python.mjs'

describe('install:python', () => {
  it('installs unless FREE_SKIP_PYTHON is exactly 1', () => {
    assert.equal(shouldInstallPython({}), true)
    assert.equal(shouldInstallPython({ FREE_SKIP_PYTHON: '' }), true)
    assert.equal(shouldInstallPython({ FREE_SKIP_PYTHON: 'true' }), true)
    assert.equal(shouldInstallPython({ FREE_SKIP_PYTHON: '1' }), false)
  })

  it('runs the frozen sync in the parsing service directory', () => {
    assert.deepEqual(installPythonCommand(), {
      command: 'uv',
      arguments: ['sync', '--frozen'],
      cwd: fileURLToPath(new URL('../prototypes/parsing_service/', import.meta.url)),
    })
  })
})
