import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import { ensureKeiRole } from 'db/kei-role'
import { Client } from 'pg'

const directory = resolve(import.meta.dirname, '../../parsing_service')
const python = resolve(directory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

/** A real text PDF; neither its canonical representation nor extraction artifact is mocked. */
export function cataloguePdf(): Buffer {
  // The heading is not a record: discovery must neither start one there nor end the records before Valley.
  return textPdf([['Site catalogue', '1. Hill: pottery dated 1801.', '2. Valley: flint dated 1802.']])
}

/**
 * A numbered catalogue for the recipe path: a Kreis heading the entries inherit, and entry 32
 * continuing onto page 2, where its FA: value is printed. Docling joins the lines of one paragraph
 * with spaces, so two entries inside one segment are exercised by the service's unit fixtures and
 * the scanned catalogue, not by this native PDF.
 */
export function numberedCataloguePdf(): Buffer {
  return textPdf([['Kreis Heide', '31. Hill. FA: G.', '32. Valley.'], ['FA: EF.']])
}

export function textPdf(pages: string[][]): Buffer {
  const font = 3
  const pageObjects: string[] = []
  const kids: string[] = []
  for (const [index, texts] of pages.entries()) {
    const stream = texts.map((text, line) => `BT /F1 16 Tf 72 ${680 - line * 180} Td (${text}) Tj ET\n`).join('')
    const page = 4 + index * 2
    kids.push(`${page} 0 R`)
    pageObjects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${page + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    )
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pageObjects,
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
  let holdNext = false
  let releaseHeld: (() => void) | null = null
  let held: Promise<void> | null = null
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !['/v1/chat/completions', '/tokenize'].includes(request.url ?? ''))
        throw new Error(`Unexpected model request: ${request.method} ${request.url}`)
      let bytes = ''
      for await (const chunk of request) bytes += chunk
      const body = JSON.parse(bytes)
      // A verified count stands in for vLLM's /tokenize, and every completion reports the same count, as a
      // real server does: the recipe path refuses an endpoint whose counts it cannot verify.
      const counted = body.messages.reduce((total: number, message: { content: string }) =>
        total + message.content.split(/\s+/).filter(Boolean).length, 0) + 7
      if (request.url === '/tokenize') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ count: counted, max_model_len: 16384 }))
        return
      }
      if (holdNext) {
        holdNext = false
        held = new Promise<void>((resolve) => { releaseHeld = resolve })
        await held
        held = null
        releaseHeld = null
      }
      const prompt: string = body.messages.at(-1).content
      const properties = body.response_format.json_schema.schema.properties
      const candidates = Object.values(properties).some((field) =>
        typeof field === 'object' && field !== null && 'properties' in field &&
        'quote' in ((field as { properties: object }).properties))
      const records = [...prompt.matchAll(/(?:Hill|Valley):\s*(?:pottery|flint) dated \d{4}/g)].map(match => {
        const [site, finds, year] = match[0].split(/:\s*| dated /)
        return { site, finds, year: Number(year) }
      })
      let answer: unknown
      if (candidates) {
        // One recipe entry: answer from the text between the ENTRY markers only, quoting it verbatim.
        const entry = prompt.split('### ENTRY\n')[1]?.split('\n### END ENTRY')[0]
        if (!entry) throw new Error(`Recipe call without an entry: ${prompt}`)
        const kind = /FA: (\w+)/.exec(entry)
        const site = /^\d+\.\s+([^.]+)/.exec(entry)
        answer = Object.fromEntries(Object.keys(properties).map((name) => [name,
          name === 'fundart' && kind ? { value: kind[1], quote: kind[0], key: 'FA:', provenance: 'token' }
            : name === 'site_name' && site ? { value: site[1], quote: site[1], key: null, provenance: 'positional' }
              : null]))
      } else if ('starts' in properties) {
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
        usage: { prompt_tokens: counted, completion_tokens: 30 },
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
    holdNextExtraction: () => { holdNext = true },
    extractionHeld: () => held !== null,
    releaseExtraction: () => { releaseHeld?.(); holdNext = false },
    close: () => { releaseHeld?.(); return new Promise<void>((resolveClosed, reject) =>
      server.close(error => error ? reject(error) : resolveClosed())) },
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
  const inbox = process.env.FREE_PLAYWRIGHT_SOURCE_INBOX
  if (!inbox) throw new Error('Playwright must provide the shared source inbox.')
  await mkdir(inbox, { recursive: true })
  const password = randomBytes(24).toString('hex')
  const owner = new Client({ connectionString: database.href })
  await owner.connect()
  try { await ensureKeiRole(owner, { password }) } finally { await owner.end() }
  const keiDatabase = new URL(database)
  keiDatabase.username = 'kei'
  keiDatabase.password = password
  const keiClient = await DBOSClient.create({ systemDatabaseUrl: database.href,
    systemDatabaseSchemaName: 'kei_dbos', applicationName: 'kei' })
  const log = createWriteStream(logFile)
  const env: NodeJS.ProcessEnv & { KEI_EXTRACT_MODEL: string } = {
    ...process.env,
    KEI_RUNS: runs,
    KEI_SOURCE_INBOX: inbox,
    KEI_SLOT: 'free-service-e2e',
    KEI_VLLM_URL: 'http://127.0.0.1:1/v1/chat/completions',
    KEI_EXTRACT_URL: realUrl ?? fixture!.url,
    KEI_EXTRACT_MODEL: realModel ?? 'deterministic-source-reader',
    KEI_EXTRACT_TIMEOUT: '180',
    // One instruct server serves every role here; a KEI_NUEXTRACT_URL exported in the shell must not route fields away.
    KEI_NUEXTRACT_URL: '',
    CUDA_VISIBLE_DEVICES: '',
    HF_HUB_DISABLE_TELEMETRY: '1',
  }
  delete env.DATABASE_URL
  delete env.KEI_DATABASE_URL
  delete env.KEI_SYSTEM_DATABASE_URL
  function start(args: string[], workerEnv = false): Process {
    const child = spawn(python, args, { cwd: directory,
      env: workerEnv ? { ...env, KEI_SYSTEM_DATABASE_URL: keiDatabase.href } : env,
      stdio: ['ignore', 'pipe', 'pipe'] })
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
    if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return
    process.child.kill('SIGTERM')
    const timeout = setTimeout(() => process.child.kill('SIGKILL'), 10_000)
    try { await process.exited } finally { clearTimeout(timeout) }
  }
  let api: Process | undefined
  let worker: Process | undefined
  const servingMarker = 'kei worker kei-free-service-e2e serving'
  const servingCount = async () => (await readFile(logFile, 'utf8').catch(() => '')).split(servingMarker).length - 1
  async function boot() {
    const previousServing = await servingCount()
    worker = start(['-m', 'kei_exp.workflows.cli', 'worker', '--slot', 'free-service-e2e'], true)
    api = start(['-m', 'uvicorn', 'kei_exp.api:app', '--host', '127.0.0.1', '--port', new URL(url!).port])
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (api.child.exitCode !== null || api.child.signalCode !== null || worker.child.exitCode !== null || worker.child.signalCode !== null)
        throw new Error(`Real Parsing Service exited; see ${logFile}.`)
      try {
        const response = await fetch(`${url}/api/models`, { signal: AbortSignal.timeout(1000) })
        if (response.ok && await servingCount() > previousServing) return
      } catch { /* The owned API has not started listening yet. */ }
      await delay(200)
    }
    throw new Error(`Real Parsing Service did not start; see ${logFile}.`)
  }
  async function close() {
    await Promise.all([stop(api), stop(worker)])
    fixture?.releaseExtraction()
    await fixture?.close()
    await keiClient.destroy()
    log.end()
    await rm(runs, { recursive: true, force: true })
  }
  try {
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
    holdNextExtraction: () => fixture?.holdNextExtraction(),
    extractionHeld: () => fixture?.extractionHeld() ?? false,
    releaseExtraction: () => fixture?.releaseExtraction(),
    keiWorkflows: (prefix: string, projectContextId?: string) => keiClient.listWorkflows({
      workflow_id_prefix: prefix, ...(projectContextId ? { attributes: { projectContextId } } : {}),
      loadInput: true, loadOutput: true,
    }),
    keiExtractStepFinished: async (workflowID: string) =>
      (await keiClient.listWorkflowSteps(workflowID))?.some((step) =>
        step.name === 'extract_run' && step.completedAtEpochMs !== undefined) ?? false,
    async restart() { await Promise.all([stop(api), stop(worker)]); await boot() },
    async killWorker() { const running = worker; if (!running) throw new Error('Worker is not running.')
      running.child.kill('SIGKILL'); await running.exited
      const previousServing = await servingCount()
      worker = start(['-m', 'kei_exp.workflows.cli', 'worker', '--slot', 'free-service-e2e'], true)
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (worker.child.exitCode !== null || worker.child.signalCode !== null)
          throw new Error(`Replacement worker exited; see ${logFile}.`)
        if (await servingCount() > previousServing) return
        await delay(200)
      }
      throw new Error(`Replacement worker did not resume; see ${logFile}.`)
    },
    close,
  }
}
