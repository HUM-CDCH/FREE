import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const settings = JSON.parse(readFileSync(join(project, '.claude/settings.json'), 'utf8'))
const command = settings.hooks.UserPromptSubmit[0].hooks[0].command
const context = 'CODEGRAPH_CONTEXT'
const prompt = 'Where is SavedMethodSummary used, and what calls RerunIcon?'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'free-codegraph-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const main = join(root, 'main checkout')
  const worktree = join(main, '.claude/worktrees/feature')
  mkdirSync(bin)
  mkdirSync(join(main, '.git'), { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: ../../../.git/worktrees/feature\n')
  const capturedInput = join(root, 'input.json')
  const capturedCwd = join(root, 'cwd')
  writeFileSync(join(bin, 'codegraph'), `#!/bin/sh
cat > "$CODEGRAPH_TEST_INPUT"
pwd > "$CODEGRAPH_TEST_CWD"
printf '%s' '${context}'
if [ -n "$CODEGRAPH_TEST_HANG" ]; then trap '' TERM; exec sleep 30; fi
printf '%s' "$CODEGRAPH_TEST_STDERR" >&2
exit "\${CODEGRAPH_TEST_EXIT:-0}"
`, { mode: 0o755 })

  function index(directory, name = '.codegraph') {
    mkdirSync(join(directory, name), { recursive: true })
    writeFileSync(join(directory, name, 'codegraph.db'), '')
  }

  function run(payload, { cwd = project, env = {} } = {}) {
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const result = spawnSync(command, {
      shell: true,
      cwd,
      input,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        CODEGRAPH_NO_PROMPT_HOOK: '0',
        CODEGRAPH_PROMPT_HOOK: '1',
        CODEGRAPH_DIR: '',
        PATH: `${bin}:${process.env.PATH}`,
        CODEGRAPH_TEST_INPUT: capturedInput,
        CODEGRAPH_TEST_CWD: capturedCwd,
        ...env,
      },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    return result
  }

  function silent(payload, options) {
    const result = run(payload, options)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(existsSync(capturedInput), false, 'CodeGraph must not run for skipped input')
  }

  return { main, worktree, bin, capturedInput, capturedCwd, index, run, silent }
}

for (const text of [
  '<task-notification><summary>SavedMethodSummary background task completed</summary></task-notification>',
  '  \n<task-notification task-id="abc">RerunIcon task finished</task-notification>',
  '<system-reminder>Background command finished: inspect SavedMethodSummary</system-reminder>',
  '<teammate-message teammate_id="reviewer">RerunIcon review complete</teammate-message>',
  '/review SavedMethodSummary',
  ' \n/opsx:apply RerunIcon',
  '<command-message>review</command-message>\n<command-name>/review</command-name>',
  '<local-command-caveat>Review SavedMethodSummary</local-command-caveat>',
  '<local-command-stdout>RerunIcon</local-command-stdout>',
  '<agent-message from="general-purpose">SavedMethodSummary report</agent-message>',
  '<cross-session-message from="session-2">RerunIcon status</cross-session-message>',
  'Another Claude session sent a message while you were working:\n<cross-session-message from="s2">RerunIcon</cross-session-message>',
  'Another Claude session sent a message:\n<cross-session-message from="s2">SavedMethodSummary</cross-session-message>',
]) {
  it(`skips notification or command: ${text.trim().split('\n')[0]}`, (t) => {
    const f = fixture(t)
    f.index(f.main)
    f.silent({ hook_event_name: 'UserPromptSubmit', prompt: text, cwd: f.main })
  })
}

it('skips other hook events even when they include a structural prompt', (t) => {
  const f = fixture(t)
  f.index(f.main)
  f.silent({ hook_event_name: 'Notification', prompt, cwd: f.main })
})

it('stays silent in an unindexed worktree nested inside an indexed checkout', (t) => {
  const f = fixture(t)
  f.index(f.main)
  const subdirectory = join(f.worktree, 'src')
  mkdirSync(subdirectory)
  f.silent({ prompt, cwd: subdirectory })
})

it('ignores a .codegraph index when CODEGRAPH_DIR names another directory', (t) => {
  const f = fixture(t)
  f.index(f.main)
  f.index(f.worktree)
  f.silent({ prompt, cwd: f.worktree }, { env: { CODEGRAPH_DIR: '.codegraph-alt' } })
})

it('accepts an index under the CODEGRAPH_DIR override', (t) => {
  const f = fixture(t)
  f.index(f.worktree, '.codegraph-alt')
  const result = f.run({ prompt, cwd: f.worktree }, { env: { CODEGRAPH_DIR: ' .codegraph-alt ' } })
  assert.equal(result.stdout, context)
})

it('falls back to .codegraph when CODEGRAPH_DIR is not a plain name, like CodeGraph', (t) => {
  const f = fixture(t)
  f.index(f.worktree)
  const result = f.run({ prompt, cwd: f.worktree }, { env: { CODEGRAPH_DIR: join(f.worktree, '.codegraph-alt') } })
  assert.equal(result.stdout, context)
})

it('stays silent without an index, including an empty .codegraph directory', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.main, '.codegraph'))
  f.silent({ prompt, cwd: f.main })
})

it('passes the original payload and uses the indexed worktree cwd', (t) => {
  const f = fixture(t)
  f.index(f.main)
  f.index(f.worktree)
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: f.worktree, session_id: 'abc' })
  const result = f.run(input, { cwd: f.main })
  assert.equal(result.stdout, context)
  assert.equal(result.stderr, '')
  assert.equal(readFileSync(f.capturedInput, 'utf8'), input)
  assert.equal(readFileSync(f.capturedCwd, 'utf8').trim(), f.worktree)
})

it('allows ordinary prompts from a subdirectory of the indexed checkout', (t) => {
  const f = fixture(t)
  f.index(f.main)
  const subdirectory = join(f.main, 'src')
  mkdirSync(subdirectory)
  const result = f.run({ prompt, cwd: subdirectory }, { cwd: f.worktree })
  assert.equal(result.stdout, context)
  assert.equal(readFileSync(f.capturedCwd, 'utf8').trim(), subdirectory)
})

for (const payload of [
  '{broken', null, [], {},
  { prompt: '', cwd: project },
  { prompt: '  \n ', cwd: project },
  { prompt: 123, cwd: project },
  { prompt },
  { prompt, cwd: '' },
  { prompt, cwd: 123 },
  { prompt, cwd: 'relative/path' },
]) {
  it(`stays silent for invalid input: ${JSON.stringify(payload)}`, (t) => {
    const f = fixture(t)
    f.silent(payload)
  })
}

for (const env of [{ CODEGRAPH_NO_PROMPT_HOOK: '1' }, { CODEGRAPH_PROMPT_HOOK: '0' }]) {
  it(`honors the existing kill switch: ${Object.keys(env)[0]}`, (t) => {
    const f = fixture(t)
    f.index(f.main)
    f.silent({ prompt, cwd: f.main }, { env })
  })
}

it('discards output if CodeGraph fails and still allows the prompt', (t) => {
  const f = fixture(t)
  f.index(f.main)
  const result = f.run({ prompt, cwd: f.main }, {
    env: { CODEGRAPH_TEST_EXIT: '2', CODEGRAPH_TEST_STDERR: 'index unavailable' },
  })
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(existsSync(f.capturedInput), true)
})

it('kills a CodeGraph process that ignores SIGTERM and emits nothing', (t) => {
  const f = fixture(t)
  f.index(f.main)
  const started = Date.now()
  const result = f.run({ prompt, cwd: f.main }, {
    env: { CODEGRAPH_TEST_HANG: '1', CODEGRAPH_PROMPT_HOOK_TEST_TIMEOUT_MS: '200' },
  })
  assert.ok(Date.now() - started < 3000, `hook took ${Date.now() - started} ms`)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(existsSync(f.capturedInput), true)
})

it('stays silent when the CodeGraph executable is unavailable', (t) => {
  const f = fixture(t)
  f.index(f.main)
  rmSync(join(f.bin, 'codegraph'))
  symlinkSync(process.execPath, join(f.bin, 'node'))
  f.silent({ prompt, cwd: f.main }, { env: { PATH: f.bin } })
})

it('delegates an ordinary prompt that mentions a notification tag', (t) => {
  const f = fixture(t)
  f.index(f.main)
  const result = f.run({ prompt: 'Where is <task-notification> generated?', cwd: f.main })
  assert.equal(result.stdout, context)
})
