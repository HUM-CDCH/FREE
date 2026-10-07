import { mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Pool } from 'pg'
import { readDurableDiagnostics, diagnosticOptionsSchema, type DiagnosticResult } from './durable-diagnostics.js'
import { DurableNotFound } from './durable-repository.js'

export const DIAGNOSTIC_MAX_BYTES = 16_384
export const DIAGNOSTIC_USAGE = 'Usage: diagnose --owner UUID --extraction UUID [--compare UUID] [--stage discovery] [--limit 1..5] [--payload-dir PATH]'

export function diagnosticArguments(args: string[]) {
  try {
    const { values } = parseArgs({ args, options: {
      owner: { type: 'string' }, extraction: { type: 'string' }, compare: { type: 'string' },
      stage: { type: 'string' }, limit: { type: 'string' }, 'payload-dir': { type: 'string' }, help: { type: 'boolean' },
    } })
    if (values.help) return null
    const options = diagnosticOptionsSchema.parse({ owner: values.owner, extraction: values.extraction,
      compare: values.compare, stage: values.stage, limit: values.limit === undefined ? undefined : Number(values.limit),
      payloads: values['payload-dir'] !== undefined })
    return { options, directory: values['payload-dir'] }
  } catch {
    throw new Error(DIAGNOSTIC_USAGE)
  }
}

/** Keep credential-bearing fields and provider errors out of exported debug files. */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticPayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = key.toLowerCase().replace(/[-_]/g, '')
    if (['authorization', 'proxyauthorization', 'apikey', 'xapikey', 'cookie', 'setcookie',
      'password', 'secret', 'token', 'accesstoken', 'refreshtoken', 'error'].includes(name)) return [key, '[REDACTED]']
    if (name === 'url' && typeof item === 'string') {
      try {
        const url = new URL(item)
        if (url.username) url.username = '[REDACTED]'
        if (url.password) url.password = '[REDACTED]'
        for (const parameter of url.searchParams.keys())
          if (/key|token|secret|password/i.test(parameter)) url.searchParams.set(parameter, '[REDACTED]')
        return [key, url.toString()]
      } catch { return [key, '[REDACTED_URL]'] }
    }
    return [key, sanitizeDiagnosticPayload(item)]
  }))
}

export function diagnosticOutput(summary: DiagnosticResult['summary'], files: string[] = []) {
  const output = JSON.stringify({ ...summary, ...(files.length ? { payloadFiles: files } : {}) }, null, 2)
  if (Buffer.byteLength(output) > DIAGNOSTIC_MAX_BYTES)
    throw new Error('Diagnostic output is too large. Retry with --limit 1.')
  return `${output}\n`
}

export async function runDiagnosticCli(args: string[], environment = process.env,
  diagnose: typeof readDurableDiagnostics = readDurableDiagnostics,
  streams = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) }) {
  let pool: Pool | undefined
  try {
    const parsed = diagnosticArguments(args)
    if (!parsed) { streams.stdout(`${DIAGNOSTIC_USAGE}\n`); return 0 }
    if (!environment.DATABASE_URL) throw new Error('Database configuration missing.')
    pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1,
      options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5_000 })
    const result = await diagnose(pool, parsed.options)
    const files: string[] = []
    // Metadata is bounded before any debug files are written.
    diagnosticOutput(result.summary)
    if (parsed.directory) {
      const directory = await mkdtemp(join(resolve(parsed.directory), 'free-diagnostic-'))
      for (const payload of result.payloads) {
        const file = join(directory, `${payload.extraction}-${payload.capture}.json`)
        await writeFile(file, JSON.stringify(sanitizeDiagnosticPayload(payload), null, 2), { mode: 0o600, flag: 'wx' })
        files.push(file)
      }
    }
    streams.stdout(diagnosticOutput(result.summary, files))
    return 0
  } catch (error) {
    streams.stderr(`${error instanceof DurableNotFound ? 'That Extraction was not found.'
      : error instanceof Error && [DIAGNOSTIC_USAGE, 'Diagnostic output is too large. Retry with --limit 1.'].includes(error.message)
        ? error.message : 'Could not read extraction diagnostics. Check database configuration and access.'}\n`)
    return 1
  } finally { await pool?.end() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runDiagnosticCli(process.argv.slice(2))
