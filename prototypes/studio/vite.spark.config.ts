// `pnpm dev:spark`: this checkout's Studio client, with HMR, against a deployed Studio (Baratheon by default). Only
// /free/api is forwarded; no local server, database, DBOS executor or model runs. Sign-in happens in a dedicated
// browser profile (.dev/spark-browser/), and its `free_session` lives only in this process, injected into forwarded
// requests. See docs/operations/local-development.md.
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Agent } from 'node:https'
import { resolve } from 'node:path'
import { defineConfig, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite'
import { DEFAULT_RETURN_PATH, validateLocalReturnPath } from './shared/returnPath.js'
import studio from './vite.config.ts'

const spark = process.env.FREE_SPARK_ORIGIN ?? 'https://baratheon.cdch-dgxspark.lan.ku.dk:11434'
const caFile = process.env.FREE_SPARK_CA_FILE ?? resolve(import.meta.dirname, '../../.certs/spark.crt')
const write = process.env.FREE_SPARK_WRITE === '1'
const basePath = '/free'
const profile = resolve(import.meta.dirname, '../../.dev/spark-browser')
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Why a browser request must not reach Spark with the injected session, or null when it may. */
export function sparkRefusal(
  request: { method?: string; headers: Record<string, string | string[] | undefined> },
  allowWrites: boolean,
): { code: string; message: string } | null {
  const site = request.headers['sec-fetch-site']
  const unsafe = !SAFE_METHODS.has(request.method ?? 'GET')
  // Any page in the browser can reach this port; only this client's own pages may act with the session.
  if ((site && site !== 'same-origin' && site !== 'none') || (unsafe && request.headers.origin !== `http://${request.headers.host}`))
    return { code: 'origin_rejected', message: 'Request origin is not allowed.' }
  if (unsafe && !allowWrites)
    return { code: 'read_only', message: 'dev:spark is read-only against Spark. Restart it with FREE_SPARK_WRITE=1 to save.' }
  return null
}

function refuse(response: ServerResponse, refusal: { code: string; message: string }) {
  response.writeHead(403, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: refusal }))
}

let session: string | null = null
let signedOut = false
let signingIn: Promise<string> | null = null

/** Spark's session from the dedicated profile: silently when it holds one, otherwise after a headed sign-in. */
async function signIn(ca: Buffer): Promise<string> {
  const { chromium } = await import('@playwright/test')
  // Chromium has no per-profile trust store; accept exactly Spark's pinned key instead of any certificate.
  const spki = createHash('sha256').update(new X509Certificate(ca).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  for (const headless of [true, false]) {
    const context = await chromium.launchPersistentContext(profile, { headless, args: [`--ignore-certificate-errors-spki-list=${spki}`] })
    try {
      if (signedOut || !headless) await context.clearCookies({ name: 'free_session' })
      signedOut = false
      const current = async () => {
        const value = (await context.cookies(`${spark}${basePath}/`)).find((cookie) => cookie.name === 'free_session')?.value
        if (!value) return null
        const probe = await context.newPage()
        try {
          const response = await probe.goto(`${spark}${basePath}/api/auth/session`)
          return response?.ok() && (await response.json() as { authenticated?: boolean }).authenticated ? value : null
        } finally {
          await probe.close()
        }
      }
      let value = await current()
      if (!value && !headless) {
        console.info('[dev:spark] sign in to Spark in the opened browser window')
        const page = context.pages()[0] ?? await context.newPage()
        await page.goto(`${spark}${basePath}/auth/login`)
        const closed = new Promise<never>((_, reject) => context.once('close', () => reject(new Error('sign-in window closed'))))
        closed.catch(() => {})
        const deadline = Date.now() + 10 * 60_000
        while (!value && Date.now() < deadline) {
          await Promise.race([new Promise((done) => setTimeout(done, 1_000)), closed])
          value = await current()
        }
      }
      if (value) return value
    } finally {
      await context.close().catch(() => {})
    }
  }
  throw new Error('Spark sign-in did not complete.')
}

function sparkSession(ca: Buffer): Plugin {
  return {
    name: 'free-spark-session',
    configureServer(server) {
      const host = server.config.server.host
      if (host !== undefined && host !== '127.0.0.1' && host !== 'localhost')
        throw new Error('dev:spark forwards your Spark session; it listens on loopback only.')
      // Runs before Vite's proxy: sign-in and sign-out stay local, and refused requests never reach Spark.
      server.middlewares.use(async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
        const url = new URL(request.url ?? '/', 'http://local')
        if (url.pathname.startsWith(`${basePath}/api/`) || url.pathname === `${basePath}/api`) {
          const refusal = sparkRefusal(request, write)
          if (refusal) {
            console.warn(`[dev:spark] refused ${request.method} ${url.pathname}: ${refusal.code}`)
            return refuse(response, refusal)
          }
          return next()
        }
        if (url.pathname === `${basePath}/auth/login`) {
          try {
            session = await (signingIn ??= signIn(ca).finally(() => { signingIn = null }))
          } catch (error) {
            response.writeHead(502, { 'content-type': 'text/plain' })
            return response.end(`Spark sign-in failed: ${(error as Error).message}`)
          }
          const returnTo = validateLocalReturnPath(url.searchParams.get('returnTo')) ?? DEFAULT_RETURN_PATH
          response.writeHead(303, { location: `${basePath}${returnTo}` })
          return response.end()
        }
        if (url.pathname === `${basePath}/auth/logout` && request.method === 'POST') {
          const refusal = sparkRefusal(request, true)
          if (refusal) return refuse(response, refusal)
          session = null
          signedOut = true
          response.writeHead(303, { location: `${basePath}/auth/signed-out` })
          return response.end()
        }
        next()
      })
    },
  }
}

export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  process.env.STUDIO_BASE_PATH = basePath
  const base = await (studio as (env: ConfigEnv) => UserConfig | Promise<UserConfig>)(env)
  const plugins = (base.plugins as PluginOption[]).flat()
  const clientOnly = plugins.filter((plugin) => !(plugin && 'name' in plugin && plugin.name === 'free-api-functions'))
  if (clientOnly.length === plugins.length) throw new Error('vite.config.ts no longer has the free-api-functions plugin.')
  if (!existsSync(caFile))
    throw new Error(`dev:spark pins Spark's TLS certificate and found none at ${caFile}. Copy it once over SSH (docs/operations/local-development.md) or set FREE_SPARK_CA_FILE.`)
  const ca = readFileSync(caFile)
  return {
    ...base,
    plugins: [...clientOnly, sparkSession(ca)],
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true, open: `${basePath}/`,
      proxy: {
        [`^${basePath}/api(/|$|\\?)`]: {
          target: spark,
          changeOrigin: true,
          agent: new Agent({ ca }),
          secure: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (request) => {
              request.setHeader('origin', spark)
              if (session) request.setHeader('cookie', `free_session=${session}`)
              else request.removeHeader('cookie')
            })
            // Spark's cookies belong to Spark's origin: keep a renewed session here and give the browser none.
            proxy.on('proxyRes', (response) => {
              for (const cookie of response.headers['set-cookie'] ?? []) {
                const renewed = /^free_session=([^;]*)/.exec(cookie)
                if (renewed) session = renewed[1] || null
              }
              delete response.headers['set-cookie']
            })
          },
        },
      },
    },
  }
})
