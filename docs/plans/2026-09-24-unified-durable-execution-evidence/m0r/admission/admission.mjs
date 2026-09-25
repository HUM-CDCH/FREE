// M0R item 3: admission with an application-named client, return-existing,
// dequeue latency, and kill -9 around an enqueueInTransaction commit.
// Needs M0R_DB_URL (loopback free_test_m0r_*); a second database named
// `${M0R_DB_URL}_neg` must exist for the foreign-application check.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import pg from 'pg'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'

const url = process.env.M0R_DB_URL
assert.ok(url && /@127\.0\.0\.1:5432\/free_test_m0r_[a-z_]+$/.test(url), 'M0R_DB_URL must be a loopback free_test_m0r_* database')
const negUrl = `${url}_neg`
const role = process.env.M0R_ROLE ?? 'parent'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (event, data) => console.log(`RESULT ${event} ${JSON.stringify(data)}`)
const q = async (sql, params = [], conn = url) => {
  const c = new pg.Client({ connectionString: conn })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows
  } finally {
    await c.end()
  }
}

// ---- workflows (registered identically in every process) ---------------------
const stepPool = new pg.Pool({ connectionString: url, max: 3 })
async function record(step) {
  await stepPool.query('insert into admission_steps(workflow_id, step, pid) values ($1,$2,$3)', [DBOS.workflowID, step, process.pid])
}
async function chatTurnFn(question) {
  await DBOS.runStep(() => record('start'), { name: 'recordStart' })
  const release = await DBOS.recv('release', 60)
  await DBOS.runStep(() => record('answer'), { name: 'answer' })
  return { question, released: release !== null }
}
const chatTurn = DBOS.registerWorkflow(chatTurnFn, { name: 'chatTurn' })
async function pingFn() {
  await DBOS.runStep(
    () => stepPool.query('insert into latency_starts(workflow_id) values ($1) on conflict do nothing', [DBOS.workflowID]),
    { name: 'stamp' },
  )
}
DBOS.registerWorkflow(pingFn, { name: 'ping' })

function configure(name, executorID = 'local', systemDatabaseUrl = url) {
  DBOS.setConfig({ name, applicationVersion: 'm0r@1', executorID, systemDatabaseUrl, logLevel: 'error', enableOTLP: false })
}

// Same shape as admission-races.mjs: domain row first, enqueue in the same tx.
async function admit(client, id, dedup, question) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    await c.query('begin')
    await c.query('insert into admission_probe values ($1,$2)', [id, question])
    await client.enqueueInTransaction(c, { workflowName: 'chatTurn', workflowID: id, queueName: 'studio', deduplicationID: dedup }, question)
    await c.query('commit')
    return { id, action: 'created' }
  } catch (e) {
    await c.query('rollback')
    if (e.code === '23505' && e.constraint === 'admission_probe_pkey') {
      const r = await c.query('select question from admission_probe where id=$1', [id])
      return { id, action: r.rows[0]?.question === question ? 'replayed' : 'conflict' }
    }
    return { id, action: 'rejected', error: e.constructor.name }
  } finally {
    await c.end()
  }
}

// ---- child roles --------------------------------------------------------------
if (role === 'kill') {
  // A Studio process: the DBOS app and the admission client in one process.
  configure('studio')
  await DBOS.launch()
  await DBOS.registerQueue('studio')
  const client = await DBOSClient.create({ systemDatabaseUrl: url, applicationName: 'studio' })
  const id = process.env.M0R_ID
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  await c.query('begin')
  await c.query('insert into admission_probe values ($1,$2)', [id, 'q'])
  await client.enqueueInTransaction(c, { workflowName: 'chatTurn', workflowID: id, queueName: 'studio', deduplicationID: `dedup-${id}` }, 'q')
  if (process.env.M0R_KILL === 'before-commit') process.kill(process.pid, 'SIGKILL')
  await c.query('commit')
  if (process.env.M0R_KILL === 'after-commit') process.kill(process.pid, 'SIGKILL')
  // after-start: wait until this process has dequeued it and run its first step
  for (;;) {
    const r = await c.query("select 1 from admission_steps where workflow_id=$1 and step='start'", [id])
    if (r.rowCount) process.kill(process.pid, 'SIGKILL')
    await sleep(50)
  }
}
if (role === 'other-app') {
  // A differently named application polling a queue called `studio`.
  configure('other', 'local', negUrl)
  await DBOS.launch()
  await DBOS.registerQueue('studio')
  console.log('READY')
  await sleep(600000)
  process.exit(0)
}

// ---- parent -------------------------------------------------------------------
function child(roleName, env) {
  const p = spawn(process.execPath, [import.meta.filename], { env: { ...process.env, M0R_ROLE: roleName, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  p.stdout.on('data', (d) => (stdout += d))
  p.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise((r) => p.on('exit', (code, signal) => r({ code, signal })))
  return { p, exited, stdout: () => stdout, stderr: () => stderr }
}
const status = async (id, conn = url) =>
  (await q('select status, application_name, executor_id, queue_name, deduplication_id from dbos.workflow_status where workflow_uuid=$1', [id], conn))[0]
async function waitStatus(id, want, ms = 20000) {
  const until = Date.now() + ms
  for (;;) {
    const s = await status(id)
    if (s && want.includes(s.status)) return s
    if (Date.now() > until) return s
    await sleep(100)
  }
}

await q('create table admission_probe(id text primary key, question text not null)')
await q('create table admission_steps(id bigserial primary key, workflow_id text not null, step text not null, pid int not null, at timestamptz not null default clock_timestamp())')
await q('create table latency_starts(workflow_id text primary key, started_ms double precision not null default extract(epoch from clock_timestamp())*1000)')

// (d) kill -9 around the commit. DBOS is not yet launched in this process, so
// only the killed child could have run anything.
const killCases = {}
for (const [id, kill] of [['kill-before', 'before-commit'], ['kill-after', 'after-commit'], ['kill-after-start', 'after-start']]) {
  const c = child('kill', { M0R_ID: id, M0R_KILL: kill })
  const exit = await Promise.race([c.exited, sleep(30000).then(() => 'timeout')])
  killCases[id] = {
    exit,
    row: (await q('select count(*)::int n from admission_probe where id=$1', [id]))[0].n,
    workflow: (await status(id)) ?? null,
    stepsBeforeRestart: (await q('select step from admission_steps where workflow_id=$1 order by id', [id])).map((r) => r.step),
    stderr: c.stderr().split('\n').filter(Boolean).slice(0, 2),
  }
}

// (a) negative ownership: an app named `other` polls a queue named `studio`;
// a studio-owned workflow enqueued there stays ENQUEUED.
await q('create table if not exists admission_steps(id bigserial primary key, workflow_id text not null, step text not null, pid int not null, at timestamptz not null default clock_timestamp())', [], negUrl)
const other = child('other-app', { M0R_DB_URL: url })
const readyUntil = Date.now() + 30000
while (!other.stdout().includes('READY') && Date.now() < readyUntil) await sleep(100)
const negClient = await DBOSClient.create({ systemDatabaseUrl: negUrl, applicationName: 'studio' })
await negClient.enqueue({ workflowName: 'chatTurn', workflowID: 'neg-studio-owned', queueName: 'studio' }, 'q')
const unownedNegClient = await DBOSClient.create({ systemDatabaseUrl: negUrl })
await unownedNegClient.enqueue({ workflowName: 'chatTurn', workflowID: 'neg-unowned', queueName: 'studio' }, 'q')
await sleep(4000)
const negQueueOwner = (await q("select application_name from dbos.queues where name='studio'", [], negUrl))[0]
const negResult = {
  queueOwner: negQueueOwner?.application_name,
  studioOwned: await status('neg-studio-owned', negUrl),
  unowned: await status('neg-unowned', negUrl),
}
other.p.kill('SIGKILL')
await negClient.destroy()
await unownedNegClient.destroy()
out('foreign-app-does-not-dequeue', negResult)

// The Studio application.
configure('studio')
await DBOS.launch()
await DBOS.registerQueue('studio')
await DBOS.registerQueue('studio-fast', { minPollingIntervalMs: 100 })
const client = await DBOSClient.create({ systemDatabaseUrl: url, applicationName: 'studio' })

// (d) continued: after restart the committed admissions run to completion.
for (const id of ['kill-after', 'kill-after-start']) {
  await waitStatus(id, ['PENDING'])
  await DBOS.send(id, 'go', 'release')
}
for (const id of ['kill-before', 'kill-after', 'kill-after-start']) {
  if (killCases[id].workflow) {
    await waitStatus(id, ['SUCCESS', 'ERROR'], 30000)
  }
  killCases[id].afterRestart = {
    workflow: (await status(id)) ?? null,
    steps: (await q('select step, count(*)::int n from admission_steps where workflow_id=$1 group by step order by step', [id])).map((r) => `${r.step}x${r.n}`),
  }
  out('kill-around-commit', { id, ...killCases[id] })
}
assert.equal(killCases['kill-before'].row, 0)
assert.equal(killCases['kill-before'].workflow, null)
assert.equal(killCases['kill-after'].afterRestart.workflow.status, 'SUCCESS')
assert.equal(killCases['kill-after-start'].afterRestart.workflow.status, 'SUCCESS')

// (a) races with the studio-named client; Studio owns and runs the winner.
const same = await Promise.all([admit(client, 'same', 'rev-1', 'question'), admit(client, 'same', 'rev-1', 'question')])
assert.deepEqual(same.map((r) => r.action).sort(), ['created', 'replayed'])
const different = await Promise.all([admit(client, 'different-a', 'rev-2', 'a'), admit(client, 'different-b', 'rev-2', 'b')])
assert.deepEqual(different.map((r) => r.action).sort(), ['created', 'rejected'])
const persisted = (await q("select id from admission_probe where id like 'different-%'")).map((r) => r.id)
assert.equal(persisted.length, 1)
const winner = persisted[0]
const running = { same: await waitStatus('same', ['PENDING']), [winner]: await waitStatus(winner, ['PENDING']) }
await DBOS.send('same', 'go', 'release')
await DBOS.send(winner, 'go', 'release')
const results = {
  same: await DBOS.retrieveWorkflow('same').getResult(),
  [winner]: await DBOS.retrieveWorkflow(winner).getResult(),
}
out('studio-client-races', { same, different, persistedQuestions: persisted.length, runningWhileBlocked: running, results })
for (const s of Object.values(running)) {
  assert.equal(s.status, 'PENDING')
  assert.equal(s.application_name, 'studio')
}

// Foreign-owned and unowned rows on the studio queue, with Studio polling it.
const foreign = await DBOSClient.create({ systemDatabaseUrl: url, applicationName: 'someone-else' })
await foreign.enqueue({ workflowName: 'chatTurn', workflowID: 'foreign-owned', queueName: 'studio' }, 'q')
const unowned = await DBOSClient.create({ systemDatabaseUrl: url })
await unowned.enqueue({ workflowName: 'chatTurn', workflowID: 'unowned', queueName: 'studio' }, 'q')
await sleep(4000)
const ownership = { foreignOwned: await status('foreign-owned'), unowned: await status('unowned') }
out('ownership-on-studio-queue', ownership)
await DBOS.send('unowned', 'go', 'release')
await foreign.cancelWorkflow('foreign-owned')
await foreign.destroy()
await unowned.destroy()

// (b) return-existing: rejected inside a caller-owned transaction, works outside.
const holder = await client.enqueue({ workflowName: 'chatTurn', workflowID: 'rx-holder', queueName: 'studio', deduplicationID: 'rx' }, 'q')
await waitStatus('rx-holder', ['PENDING'])
let inTx
{
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  await c.query('begin')
  try {
    await client.enqueueInTransaction(c, { workflowName: 'chatTurn', workflowID: 'rx-in-tx', queueName: 'studio', deduplicationID: 'rx', duplicationPolicy: 'return-existing' }, 'q')
    inTx = 'accepted'
  } catch (e) {
    inTx = `${e.constructor.name}: ${e.message}`
  }
  await c.query('rollback')
  await c.end()
}
const outside = await client.enqueue({ workflowName: 'chatTurn', workflowID: 'rx-outside', queueName: 'studio', deduplicationID: 'rx', duplicationPolicy: 'return-existing' }, 'q')
const rx = { inTransaction: inTx, outsideReturned: outside.workflowID, holder: holder.workflowID, outsideRowCreated: Boolean(await status('rx-outside')) }
out('return-existing', rx)
assert.equal(outside.workflowID, 'rx-holder')
await DBOS.send('rx-holder', 'go', 'release')

// (c) dequeue latency: commit of an enqueueInTransaction -> first step start.
async function sample(queueName, id) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  await c.query('begin')
  await client.enqueueInTransaction(c, { workflowName: 'ping', workflowID: id, queueName }, )
  await c.query('commit')
  const t0 = Number((await c.query('select extract(epoch from clock_timestamp())*1000 as ms')).rows[0].ms)
  await c.end()
  return t0
}
async function measure(queueName, n, spread) {
  const lat = []
  for (let i = 0; i < n; i++) {
    await sleep(Math.random() * spread) // decorrelate from the poll phase
    const id = `lat-${queueName}-${i}-${Date.now()}`
    const t0 = await sample(queueName, id)
    await DBOS.retrieveWorkflow(id).getResult()
    const t1 = (await q('select started_ms from latency_starts where workflow_id=$1', [id]))[0].started_ms
    lat.push(t1 - t0)
  }
  return lat
}
async function burst(queueName, n) {
  const ids = Array.from({ length: n }, (_, i) => `burst-${queueName}-${i}-${Date.now()}`)
  const t0s = await Promise.all(ids.map((id) => sample(queueName, id)))
  await Promise.all(ids.map((id) => DBOS.retrieveWorkflow(id).getResult()))
  const starts = await q('select workflow_id, started_ms from latency_starts where workflow_id = any($1)', [ids])
  const byId = Object.fromEntries(starts.map((r) => [r.workflow_id, r.started_ms]))
  return ids.map((id, i) => byId[id] - t0s[i])
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)])
}
const summary = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) })
out('dequeue-latency', {
  defaultPolling1000ms: summary(await measure('studio', 20, 1000)),
  minPollingIntervalMs100: summary(await measure('studio-fast', 20, 200)),
  burst10Default: summary(await burst('studio', 10)),
  burst10Fast: summary(await burst('studio-fast', 10)),
})

await client.destroy()
await DBOS.shutdown()
await stepPool.end()
out('done', { ok: true })
process.exit(0)
