import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = resolve(import.meta.dirname, '../../parsing_service')
const python = resolve(directory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

/** A real text PDF; neither its canonical representation nor extraction artifact is mocked. */
export function cataloguePdf(): Buffer {
  const texts = [
    '1. Hill: pottery dated 1801.',
    '2. Valley: flint dated 1802.',
  ]
  const stream = texts.map((text, index) => `BT /F1 16 Tf 72 ${680 - index * 180} Td (${text}) Tj ET\n`).join('')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(content)
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  content += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(content)
}

/** Only the model boundary is scripted. Responses are derived from the real parser text in each prompt. */
async function modelServer() {
  let calls = 0
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
        throw new Error(`Unexpected model request: ${request.method} ${request.url}`)
      let bytes = ''
      for await (const chunk of request) bytes += chunk
      const body = JSON.parse(bytes)
      const prompt: string = body.messages.at(-1).content
      const properties = body.response_format.json_schema.schema.properties
      const records = [...prompt.matchAll(/(?:Hill|Valley):\s*(?:pottery|flint) dated \d{4}/g)].map(match => {
        const [site, finds, year] = match[0].split(/:\s*| dated /)
        return { site, finds, year: Number(year) }
      })
      let answer: unknown
      if ('starts' in properties) {
        const starts = [...prompt.matchAll(/\[(B\d+)\]([^]*?)(?=\[B\d+\]|$)/g)]
          .filter(match => /Hill:|Valley:/.test(match[2])).map(match => match[1])
        if (starts.length !== 2) throw new Error(`Discovery did not receive both parsed entries: ${prompt}`)
        answer = { starts, end: null }
      } else if ('records' in properties) {
        if (records.length !== 2) throw new Error(`Article extraction did not receive both entries: ${prompt}`)
        answer = { records }
      } else if ('site' in properties) {
        if (records.length !== 1) throw new Error(`Record extraction received ${records.length} records: ${prompt}`)
        answer = records[0]
      } else throw new Error(`Unexpected model schema: ${JSON.stringify(properties)}`)
      calls++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Model fixture did not bind a TCP port.')
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    count: () => calls,
    close: () => new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed())),
  }
}

type Process = { child: ChildProcess; exited: Promise<number | null> }

export async function startRealService(logFile: string) {
  const url = process.env.FREE_PLAYWRIGHT_SERVICE_URL
  if (!url) throw new Error('Run this test with playwright.service.config.ts.')
  const address = new URL(url)
  if (address.hostname !== '127.0.0.1' || address.protocol !== 'http:' || !address.port)
    throw new Error('The test service must listen on an explicit loopback port.')
  // Refuse a pre-existing listener before admitting anything; this test owns the service it restarts.
  const lease = createServer()
  await new Promise<void>((resolveListening, reject) => {
    lease.once('error', reject)
    lease.listen(Number(address.port), address.hostname, resolveListening)
  })
  await new Promise<void>((resolveClosed, reject) => lease.close(error => error ? reject(error) : resolveClosed()))
  const database = new URL(process.env.DATABASE_URL ?? '')
  if (database.hostname !== '127.0.0.1' || database.pathname !== '/free_test_real_service' ||
      database.username !== 'free_e2e' || database.port !== process.env.FREE_PLAYWRIGHT_POSTGRES_PORT)
    throw new Error('The real-service test requires its own Playwright database.')
  // libpq may otherwise inherit PGHOSTADDR even when a URL supplies its host.
  database.searchParams.set('hostaddr', '127.0.0.1')
  const realUrl = process.env.FREE_REAL_EXTRACT_URL
  const realModel = process.env.FREE_REAL_EXTRACT_MODEL
  if (Boolean(realUrl) !== Boolean(realModel))
    throw new Error('Provide both FREE_REAL_EXTRACT_URL and FREE_REAL_EXTRACT_MODEL, or neither.')
  const fixture = realUrl ? null : await modelServer()
  const runs = await mkdtemp(join(tmpdir(), 'free-real-service-'))
  const log = createWriteStream(logFile)
  const env = {
    ...process.env,
    KEI_DATABASE_URL: database.href,
    KEI_RUNS: runs,
    KEI_SLOT: 'free-service-e2e',
    KEI_VLLM_URL: 'http://127.0.0.1:1/v1/chat/completions',
    KEI_EXTRACT_URL: realUrl ?? fixture!.url,
    KEI_EXTRACT_MODEL: realModel ?? 'deterministic-source-reader',
    KEI_EXTRACT_TIMEOUT: '180',
    CUDA_VISIBLE_DEVICES: '',
    HF_HUB_DISABLE_TELEMETRY: '1',
  }
  function start(args: string[]): Process {
    const child = spawn(python, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.pipe(log, { end: false })
    child.stderr!.pipe(log, { end: false })
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', resolveExit)
    })
    // A failure remains observable through `exited` while avoiding an unhandled rejection before readiness.
    void exited.catch(() => undefined)
    return { child, exited }
  }
  async function stop(process: Process | undefined) {
    if (!process || process.child.exitCode !== null) return
    process.child.kill('SIGTERM')
    const timeout = setTimeout(() => process.child.kill('SIGKILL'), 10_000)
    try { await process.exited } finally { clearTimeout(timeout) }
  }
  let api: Process | undefined
  let worker: Process | undefined
  async function boot() {
    worker = start(['-m', 'kei_exp.jobs.cli', 'worker'])
    api = start(['-m', 'uvicorn', 'kei_exp.api:app', '--host', '127.0.0.1', '--port', new URL(url!).port])
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (api.child.exitCode !== null || worker.child.exitCode !== null)
        throw new Error(`Real Parsing Service exited; see ${logFile}.`)
      try {
        const response = await fetch(`${url}/api/runs`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) return
      } catch { /* The owned API has not started listening yet. */ }
      await delay(200)
    }
    throw new Error(`Real Parsing Service did not start; see ${logFile}.`)
  }
  async function close() {
    await Promise.all([stop(api), stop(worker)])
    await fixture?.close()
    log.end()
    await rm(runs, { recursive: true, force: true })
  }
  try {
    const migration = start(['-m', 'kei_exp.jobs.cli', 'schema', '--apply'])
    if (await migration.exited !== 0) throw new Error(`Service migration failed; see ${logFile}.`)
    await boot()
  } catch (error) {
    await close()
    throw error
  }
  return {
    url,
    runs,
    model: env.KEI_EXTRACT_MODEL,
    modelCalls: () => fixture?.count() ?? null,
    async restart() { await Promise.all([stop(api), stop(worker)]); await boot() },
    close,
  }
}
