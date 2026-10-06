/** Runs the kei stand-in (kei-stand-in-cli.ts) in a child process and drives its control API. A test process whose own
 *  DBOS is Studio's cannot host a second DBOS application, so kei lives next door, as it does in production.
 *  Test-only: nothing in the runtime imports it. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { KeiDeleteRunsRequest, StandInFailure } from './kei-stand-in.js'

/** How the stand-in finishes each workflow: `'auto'` answers at once from the fixture, `'hold'` parks the decision
 *  until `answer`, `{ failure }` answers with that failure. A policy call changes only the workflows it names. */
export type StandInRule = 'auto' | 'hold' | { failure: StandInFailure }
export type StandInPolicy = { convert?: StandInRule }
export type HeldWork = { workflowId: string; workflow: 'convert'; request: unknown }
/** Releases a held decision: a failure, or the `'auto'` conversion. */
export type StandInAnswer = { failure: StandInFailure } | { convert: 'auto' }
export type KeiStandInProcess = Readonly<{
  /** kei's read API (and the control routes under /control/). */
  url: string
  policy(policy: StandInPolicy): Promise<void>
  held(): Promise<HeldWork[]>
  answer(workflowId: string, answer: StandInAnswer): Promise<void>
  /** Every `deleteRuns` request the stand-in received, in order. */
  deleteRunsRequests(): Promise<readonly KeiDeleteRunsRequest[]>
  /** Kills the stand-in without letting it stop (a kei crash) and waits for it to exit. */
  kill(signal?: NodeJS.Signals): Promise<void>
  /** Stops the stand-in (SIGTERM closes its server and DBOS) and waits for it to exit. */
  stop(): Promise<void>
}>

const CLI = fileURLToPath(new URL('./kei-stand-in-cli.ts', import.meta.url))
/** `--import tsx` resolves from the child's working directory, so the child runs in this package, which has tsx. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const STARTUP_MS = 30_000
const STOP_MS = 30_000
const SERVING = /^kei stand-in serving (\d+)$/

export async function spawnKeiStandIn(options: {
  databaseUrl: string
  schema: string
  port?: number
  fixture?: string
}): Promise<KeiStandInProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      KEI_STAND_IN_DATABASE_URL: options.databaseUrl,
      KEI_STAND_IN_SCHEMA: options.schema,
      KEI_STAND_IN_PORT: String(options.port ?? 0),
      ...(options.fixture === undefined ? {} : { KEI_STAND_IN_FIXTURE: options.fixture }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })))
  // Drained all the time, so a chatty child never blocks on a full pipe; the tail explains a failed start or stop.
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_192)
  })
  const lines = createInterface({ input: child.stdout })
  const running = () => child.exitCode === null && child.signalCode === null
  const failure = (message: string) => new Error(`${message}\n${redacted(stderr)}`.trim())

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(failure(`The kei stand-in did not start within ${STARTUP_MS / 1000} s.`))
    }, STARTUP_MS)
    lines.on('line', (line) => {
      const serving = SERVING.exec(line)
      if (!serving) return
      clearTimeout(timer)
      resolve(Number(serving[1]))
    })
    void exited.then(({ code, signal }) => {
      clearTimeout(timer)
      reject(failure(`The kei stand-in exited (${signal ?? `code ${code}`}) before it served.`))
    })
  })
  const url = `http://127.0.0.1:${port}`

  async function control(path: string, init?: { method: 'POST'; body: unknown }): Promise<Response> {
    const response = await fetch(`${url}/control/${path}`, init && {
      method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body),
    })
    if (!response.ok) throw new Error(`The kei stand-in answered ${response.status} to ${path}: ${await response.text()}`)
    return response
  }

  return {
    url,
    async policy(policy) {
      await control('policy', { method: 'POST', body: policy })
    },
    async held() {
      return (await (await control('held')).json()) as HeldWork[]
    },
    async answer(workflowId, answer) {
      await control('answer', { method: 'POST', body: { workflowId, ...answer } })
    },
    async deleteRunsRequests() {
      return (await (await control('delete-runs')).json()) as KeiDeleteRunsRequest[]
    },
    async kill(signal = 'SIGKILL') {
      if (running()) child.kill(signal)
      await exited
    },
    async stop() {
      if (!running()) return
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS)
      const { code, signal } = await exited
      clearTimeout(timer)
      if (code !== 0) throw failure(`The kei stand-in did not stop cleanly (${signal ?? `code ${code}`}).`)
    },
  }
}

/** A connection string's password never reaches a test report. */
function redacted(text: string): string {
  return text.replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, '$1***@')
}
