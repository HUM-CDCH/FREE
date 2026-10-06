import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

// Mirrors CodeGraph 1.5 codeGraphDirName(): CODEGRAPH_DIR must be a plain
// directory name; anything else falls back to the default.
function indexDirName() {
  const raw = process.env.CODEGRAPH_DIR?.trim()
  if (!raw || raw === '.' || raw.includes('..') || raw.includes('/') || raw.includes('\\') || isAbsolute(raw)) return '.codegraph'
  return raw
}

// CodeGraph walks ancestors without stopping at Git worktrees. Never let a
// nested worktree borrow the main checkout's index, even from a subdirectory.
function hasLocalIndex(cwd) {
  const db = join(indexDirName(), 'codegraph.db')
  let directory = realpathSync(cwd)
  if (!statSync(directory).isDirectory()) return false
  while (true) {
    if (existsSync(join(directory, db))) return true
    if (existsSync(join(directory, '.git'))) return false
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

function main() {
  if (process.env.CODEGRAPH_NO_PROMPT_HOOK === '1' || process.env.CODEGRAPH_PROMPT_HOOK === '0') return
  const raw = readFileSync(0, 'utf8')
  const input = JSON.parse(raw)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'UserPromptSubmit') return
  if (typeof input.prompt !== 'string' || typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return
  const prompt = input.prompt.trimStart()
  if (!prompt.trim() || prompt.startsWith('/')) return
  // Claude submits background reports, subagent hand-backs and cross-session
  // messages through UserPromptSubmit too. Command expansions and synthetic
  // messages use these leading envelope tags or the cross-session preamble.
  if (/^<(?:task-notification|system-reminder|teammate-message|agent-message|cross-session-message|command-name|command-message|local-command-caveat|local-command-stdout)(?:\s|>)/.test(prompt)) return
  if (prompt.startsWith('Another Claude session sent a message')) return
  if (!hasLocalIndex(input.cwd)) return

  const result = spawnSync('codegraph', ['prompt-hook'], {
    cwd: input.cwd,
    input: raw,
    encoding: 'utf8',
    // SIGKILL: a child ignoring SIGTERM would otherwise keep spawnSync waiting.
    // The env override exists only so tests can exercise the timeout quickly.
    timeout: Number(process.env.CODEGRAPH_PROMPT_HOOK_TEST_TIMEOUT_MS) || 10_000,
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  if (!result.error && result.status === 0 && result.stdout) process.stdout.write(result.stdout)
}

// This hook adds optional context; malformed input or unavailable tooling must
// leave the prompt usable and contribute no hook diagnostics or context.
try {
  main()
} catch {}
