import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const STUDIO_ROOT = resolve(import.meta.dirname, '../..')
const CHILD_LIMIT_MS = 120_000

export type WorkflowChildExit = {
  code: number | null
  signal: NodeJS.Signals | null
  /** The child's stdout and stderr, interleaved as they arrived. */
  output: string
}

/**
 * Runs one scenario of test/support/scenarios/ in a Studio child process and resolves when it exits. The child is
 * `node --import tsx`, not the `tsx` CLI: the CLI forks a child that a SIGKILL of the CLI would leave running (M0R 2).
 */
export function runWorkflowChild(
  scenario: string,
  env: NodeJS.ProcessEnv,
  options: { /** The child, once spawned: a test that must kill it from outside (a call in flight it cannot see) uses this. */ spawned?(kill: () => void): void } = {},
): Promise<WorkflowChildExit> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/support/workflowChild.ts', scenario], {
    cwd: STUDIO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  options.spawned?.(() => child.kill('SIGKILL'))
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  const { promise, resolve: exited, reject } = Promise.withResolvers<WorkflowChildExit>()
  const limit = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error(`The ${scenario} scenario did not exit within ${CHILD_LIMIT_MS / 1000} s.\n${output}`))
  }, CHILD_LIMIT_MS)
  child.once('error', (error) => {
    clearTimeout(limit)
    reject(error)
  })
  // 'close', not 'exit': both pipes have drained, so the output is complete.
  child.once('close', (code, signal) => {
    clearTimeout(limit)
    exited({ code, signal, output })
  })
  return promise
}
