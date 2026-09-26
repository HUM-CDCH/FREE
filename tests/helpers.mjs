// Shared plumbing for the black-box contract suite. Everything here talks to
// the running stack over HTTP exactly as a browser would; nothing imports
// application code.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  developmentComposeEnvironment,
  ensureCertificates,
} from '../scripts/free.mjs'

// The local stack terminates TLS with a locally-trusted mkcert certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

export const ROOT = resolve(import.meta.dirname, '..')
export const ORIGIN = 'https://localhost:41843'
export const BASE = `${ORIGIN}/free`
export const API = `${BASE}/api`
export const OLLAMA_BASE_URL =
  process.env.FREE_TEST_OLLAMA_BASE_URL ?? 'http://host.docker.internal:11434'
export const OLLAMA_MODEL = process.env.FREE_TEST_OLLAMA_MODEL ?? 'qwen3.8:latest'

export function compose(args, options = {}) {
  const env = {
    ...developmentComposeEnvironment(),
    COMPOSE_PROJECT_NAME: 'free-system-m4',
    FREE_NGINX_PORT: '41843',
    FREE_MOCK_OIDC_PORT: '41844',
    FREE_POSTGRES_PORT: '45445',
    FREE_ENTRA_MOCK_BROWSER_ISSUER: 'http://localhost:41844/dev',
    STUDIO_ORIGIN: ORIGIN,
  }
  const result = spawnSync('docker', ['compose', '-f', 'compose.yaml', '-f', 'compose.override.yaml',
    '-f', 'tests/compose.system.yaml', '--profile', 'mock-oidc', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 600_000,
  })
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(
      `docker compose ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`,
    )
  return result
}

export async function healthy() {
  try {
    const response = await fetch(`${API}/healthz`)
    return response.status === 200
  } catch {
    return false
  }
}

export async function waitForHealth(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthy()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
  }
  throw new Error('The stack did not become healthy in time.')
}

/** Start the stack the way `pnpm dev` does when it is not already running. */
export async function ensureStackUp() {
  if (await healthy()) return
  ensureCertificates()
  compose(['up', '-d', '--build', '--wait'])
  await waitForHealth()
}

// A minimal per-host cookie jar: enough for the session and OIDC redirects.
export class Session {
  #cookies = new Map() // host -> Map(name -> value)

  #store(url, response) {
    const host = new URL(url).host
    const jar = this.#cookies.get(host) ?? new Map()
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const separator = pair.indexOf('=')
      jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1))
    }
    this.#cookies.set(host, jar)
  }

  #cookieHeader(url) {
    const jar = this.#cookies.get(new URL(url).host)
    if (!jar || jar.size === 0) return undefined
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async fetch(url, init = {}) {
    const headers = new Headers(init.headers)
    const cookie = this.#cookieHeader(url)
    if (cookie) headers.set('cookie', cookie)
    const response = await fetch(url, { ...init, headers, redirect: 'manual' })
    this.#store(url, response)
    return response
  }

  /** Follow redirects across hosts, carrying each host's cookies. */
  async follow(url, maximum = 15) {
    let current = url
    for (let hop = 0; hop < maximum; hop += 1) {
      const response = await this.fetch(current)
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location)
        return { response, url: current }
      current = new URL(location, current).href
    }
    throw new Error('Too many redirects.')
  }

  /** Sign in through the mock OIDC provider — the real MSAL code path. */
  async login() {
    const { response, url } = await this.follow(
      `${BASE}/auth/login?returnTo=%2F&fragmentCaptured=1`,
    )
    if (response.status !== 200 || !url.startsWith(BASE))
      throw new Error(`Sign-in did not land back in the app (${response.status} at ${url}).`)
  }

  async api(path, init = {}) {
    const headers = new Headers(init.headers)
    if (init.body && !(init.body instanceof FormData))
      headers.set('content-type', 'application/json')
    if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
    const response = await this.fetch(`${API}${path}`, { ...init, headers })
    const text = await response.text()
    let body = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
}

/** A one-page PDF whose text content the extraction tests assert against. */
export function probePdf() {
  const stream = `BT /F1 18 Tf 72 720 Td (Contract probe document.) Tj 0 -28 Td (Margaret Cavendish published Observations in 1666.) Tj 0 -28 Td (The Royal Society was founded in London in 1660.) Tj ET`
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = `%PDF-1.4\n`
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= objects.length; index += 1)
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
