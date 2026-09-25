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

  const cwd = fileURLToPath(new URL('../prototypes/parsing_service/', import.meta.url))

  it('runs the frozen sync in the parsing service directory', () => {
    assert.deepEqual(installPythonCommand('linux'), {
      command: 'uv',
      arguments: ['sync', '--frozen'],
      cwd,
    })
  })

  it('runs uv through cmd.exe on Windows so a .cmd shim resolves', () => {
    assert.deepEqual(installPythonCommand('win32'), {
      command: process.env.ComSpec ?? 'cmd.exe',
      arguments: ['/d', '/s', '/c', 'uv sync --frozen'],
      cwd,
    })
  })

  it('defaults to the form for this host platform', () => {
    assert.deepEqual(installPythonCommand(), installPythonCommand(process.platform))
    if (process.platform === 'win32') assert.equal(installPythonCommand().arguments.at(-1), 'uv sync --frozen')
    else assert.equal(installPythonCommand().command, 'uv')
  })
})
