// M0R item 2 driver: build variants, kill -9 recovery per runtime, dev reload.
// Requires M0R_DB_URL (loopback free_test_m0r_* database). Run from this dir.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import pg from 'pg'

const url = process.env.M0R_DB_URL
assert.ok(url && /@127\.0\.0\.1:5432\/free_test_m0r_/.test(url), 'M0R_DB_URL must be a loopback free_test_m0r_* database')
const here = import.meta.dirname
const vite = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js')
const control = new pg.Client({ connectionString: url })
await control.connect()
await control.query(
  'create table if not exists lifecycle_step_runs(id bigserial primary key, workflow_id text not null, step text not null, pid int not null, at timestamptz not null default clock_timestamp())',
)
const out = (event, data) => console.log(`RESULT ${event} ${JSON.stringify(data)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- (a) SSR externalization ------------------------------------------------
function build(config) {
  const r = spawnSync(process.execPath, [vite, 'build', '--config', config], { cwd: here, encoding: 'utf8' })
  const text = `${r.stdout}\n${r.stderr}`
  const error = text.match(/Error: \[vite\]: ([^\n]+)/)?.[1]
  return { config, ok: r.status === 0, error }
}
const builds = [
  'vite.server.config.ts',
  'vite.server.external.config.ts',
  'vite.server.bundled.config.ts',
  'vite.server.bundled-optional-external.config.ts',
].map(build)
for (const b of builds) out('build', b)
const dbosImport = (file) =>
  existsSync(file) &&
  /^import \{ DBOS \} from "@dbos-inc\/dbos-sdk";$/m.test(spawnSync('cat', [file], { encoding: 'utf8' }).stdout)
out('dbos-external', {
  studioDefault: dbosImport(`${here}/dist/server/index.js`),
  explicitExternal: dbosImport(`${here}/dist/server-external/index.js`),
})

// ---- process helpers ----------------------------------------------------------
function run(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: here,
    env: { ...process.env, M0R_DB_URL: url, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const events = []
  let stderr = ''
  let buffer = ''
  child.stdout.on('data', (d) => {
    buffer += d
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (line.startsWith('M0R ')) events.push(JSON.parse(line.slice(4)))
    }
  })
  child.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  return { label, child, events, exited, stderr: () => stderr }
}
async function waitFor(pred, ms, what) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = await pred()
    if (v) return v
    await sleep(100)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const stepCounts = async (id) =>
  Object.fromEntries(
    (await control.query('select step, count(*)::int n, array_agg(distinct pid) pids from lifecycle_step_runs where workflow_id=$1 group by step', [id])).rows.map((r) => [r.step, { n: r.n, pids: r.pids }]),
  )
const wfStatus = async (id) =>
  (await control.query('select status, name, recovery_attempts from dbos.workflow_status where workflow_uuid=$1', [id])).rows[0]

// ---- (b)/(c) kill -9 recovery per runtime --------------------------------------
const runtimes = {
  bundle: ['node', ['dist/server/index.js']],
  // `node --import tsx` keeps one process; the `tsx` CLI forks a child that a
  // SIGKILL of the CLI would orphan.
  tsx: ['node', ['--import', 'tsx', 'server/index.ts']],
  'vite-dev': ['node', ['dev-host.mjs']],
}
for (const [runtime, [cmd, args]] of Object.entries(runtimes)) {
  const id = `lc-${runtime}-${Date.now()}`
  const env = { M0R_RUNTIME: runtime, M0R_WORKFLOW_ID: id }
  const first = run(`${runtime}-start`, cmd, args, { ...env, M0R_MODE: 'start', M0R_SLEEP_MS: '8000' })
  try {
    await waitFor(async () => (await stepCounts(id))['B-start'], 30000, `${runtime} B-start`)
  } catch (e) {
    first.child.kill('SIGKILL')
    console.error(first.stderr(), JSON.stringify(first.events))
    throw e
  }
  await sleep(500) // mid-sleep of step B
  first.child.kill('SIGKILL')
  const exit = await first.exited
  const afterKill = { status: await wfStatus(id), steps: await stepCounts(id) }
  const second = run(`${runtime}-recover`, cmd, args, { ...env, M0R_MODE: 'recover' })
  const recovered = await Promise.race([
    second.exited.then(() => second.events.find((e) => e.event === 'recovered-result')),
    sleep(60000).then(() => undefined),
  ])
  if (!recovered) {
    second.child.kill('SIGKILL')
    console.error(second.stderr())
  }
  const final = { status: await wfStatus(id), steps: await stepCounts(id) }
  const firstPid = first.child.pid
  const secondPid = second.child.pid
  const pass =
    exit.signal === 'SIGKILL' &&
    afterKill.status?.status === 'PENDING' &&
    final.status?.status === 'SUCCESS' &&
    final.steps.A?.n === 1 && final.steps.A.pids[0] === firstPid &&
    final.steps['B-start']?.n === 2 &&
    final.steps['B-end']?.n === 1 && final.steps['B-end'].pids[0] === secondPid &&
    final.steps.C?.n === 1 && final.steps.C.pids[0] === secondPid
  out('recovery', {
    runtime,
    pass,
    killedWith: exit.signal,
    afterKill,
    final,
    recoveredEvent: recovered,
    registeredNames: first.events.find((e) => e.event === 'registered-names'),
    secondLaunch: first.events.find((e) => e.event === 'second-launch')?.secondLaunch,
    devSingleton: first.events.find((e) => e.event === 'dev-singleton'),
  })
}

// ---- negative control: DBOS bundled, optional requires external ---------------
{
  const r = run('bundled-run', 'node', ['dist/server-bundled-optional-external/index.js'], { M0R_RUNTIME: 'bundled-dbos', M0R_MODE: 'none' })
  const res = await Promise.race([r.exited, sleep(15000).then(() => 'still running')])
  if (res === 'still running') r.child.kill('SIGKILL')
  out('bundled-dbos-run', {
    exit: res,
    events: r.events,
    stderr: r.stderr().split('\n').filter(Boolean).slice(0, 4),
  })
}

// ---- dev reload: re-evaluate a workflow module after launch --------------------
{
  const r = run('dev-reload', 'node', ['dev-host.mjs'], { M0R_RUNTIME: 'vite-dev', M0R_MODE: 'none', M0R_DEV_RELOAD: '1' })
  await Promise.race([r.exited, sleep(30000)])
  out('dev-reload', { events: r.events.filter((e) => e.event !== 'launched') })
}
await control.end()
