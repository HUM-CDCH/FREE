// The FREE launcher: one entry point with an explicit target.
//
//   node scripts/free.mjs local
//   node scripts/free.mjs production
//
// Compose owns the topology (compose.yaml plus compose.override.yaml or
// compose.prod.yaml); this script only prepares what Compose cannot.
// `local` prepares mkcert certificates and the per-machine environment
// values. `production` validates .env before anything starts, renders the
// host nginx include from the shared template, and starts the production
// overlay detached, waiting for health.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const NGINX_PORT = 8443
const MOCK_OIDC_PORT = 8444
const STUDIO_PORT = 5173
const NGINX_LOCATIONS_TEMPLATE = 'docker/nginx/free-studio-locations.inc.template'
const RENDERED_NGINX_LOCATIONS = '.nginx/free-studio-locations.conf'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: false,
  })
  if (result.error && !options.allowFailure) throw result.error
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`${command} ${args.join(' ')} failed.`)
  return result
}

export function ensureCertificates() {
  const certificate = resolve(ROOT, '.certs', 'studio.crt')
  const key = resolve(ROOT, '.certs', 'studio.key')
  if (existsSync(certificate) && existsSync(key)) return
  mkdirSync(resolve(ROOT, '.certs'), { recursive: true })
  const generated = run(
    'mkcert',
    ['-cert-file', certificate, '-key-file', key, 'localhost', '127.0.0.1', '::1'],
    { allowFailure: true },
  )
  if (generated.error?.code === 'ENOENT' || generated.status !== 0)
    throw new Error(
      'mkcert could not generate .certs/studio.crt. Install mkcert and run `mkcert -install` once.',
    )
}

function loadDotEnv() {
  try {
    return parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

function loadRootDatabaseUrl() {
  if (process.env.DATABASE_URL) return
  const databaseUrl = loadDotEnv()?.DATABASE_URL
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl
}

export function developmentComposeEnvironment(environment = process.env) {
  return {
    ...environment,
    // Deployment values may coexist in the root .env. Compose development is
    // deliberately self-contained; only host-run tooling consumes its
    // DATABASE_URL.
    COMPOSE_DISABLE_ENV_FILE: '1',
    DOCLING_DEVICE: 'cpu',
    FREE_NGINX_PORT: String(NGINX_PORT),
    FREE_POSTGRES_PASSWORD: 'postgres',
    STUDIO_BASE_PATH: '/free',
    STUDIO_ORIGIN: `https://localhost:${NGINX_PORT}`,
    FREE_NGINX_BIND: '127.0.0.1',
    FREE_MOCK_OIDC_BIND: '127.0.0.1',
    FREE_ENTRA_MOCK_BROWSER_ISSUER: `http://localhost:${MOCK_OIDC_PORT}/dev`,
  }
}

async function awaitChild(child) {
  process.exitCode = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise(code ?? 1))
  })
}

async function localMain(args) {
  if (args.length > 0)
    throw new Error(`The local target takes no options: ${args.join(' ')}`)
  loadRootDatabaseUrl()
  ensureCertificates()
  console.log(`\nStarting FREE at https://localhost:${NGINX_PORT}/free`)
  console.log('  identity: mock OIDC service on 127.0.0.1:8444')
  console.log('Press Ctrl+C to stop the stack.\n')
  await awaitChild(
    spawn('docker', ['compose', 'up', '--build', '--watch'], {
      cwd: ROOT,
      env: developmentComposeEnvironment(),
      stdio: 'inherit',
      shell: false,
    }),
  )
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function canonicalHttpsOrigin(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.origin === value
}

function canonicalBase64Secret(value) {
  let decoded
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return false
  }
  return decoded.toString('base64') === value && decoded.byteLength >= 32
}

// Fail before any container starts, with every problem reported at once. The
// Studio server re-validates the same values at boot; this pass exists so a
// misconfigured deployment stops here instead of in a container restart loop.
export function validateProductionEnvironment(
  environment,
  fileExists = existsSync,
) {
  const errors = []
  const value = (name) => {
    const supplied = environment[name]
    if (supplied === undefined || supplied === '') {
      errors.push(`${name} is required in .env.`)
      return null
    }
    return supplied
  }

  const origin = value('STUDIO_ORIGIN')
  if (origin !== null && !canonicalHttpsOrigin(origin))
    errors.push(
      'STUDIO_ORIGIN must be a canonical HTTPS origin with no path, query, fragment, or credentials.',
    )

  const basePath = value('STUDIO_BASE_PATH')
  if (
    basePath !== null &&
    !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath)
  )
    errors.push(
      'STUDIO_BASE_PATH must be a non-root canonical path such as /free, without a trailing slash. The shipped nginx behavior requires a non-root base path.',
    )

  const sessionSecret = value('FREE_SESSION_SECRET')
  if (sessionSecret !== null && !canonicalBase64Secret(sessionSecret))
    errors.push(
      'FREE_SESSION_SECRET must be canonical base64 decoding to at least 32 bytes (openssl rand -base64 32).',
    )

  const postgresPassword = value('FREE_POSTGRES_PASSWORD')
  if (postgresPassword !== null && !/^[0-9a-fA-F]{32,}$/.test(postgresPassword))
    errors.push(
      'FREE_POSTGRES_PASSWORD must be a generated hexadecimal password (openssl rand -hex 32).',
    )

  for (const name of ['FREE_ENTRA_TENANT_ID', 'FREE_ENTRA_CLIENT_ID']) {
    const uuid = value(name)
    if (uuid !== null && !UUID_PATTERN.test(uuid))
      errors.push(`${name} must be a UUID.`)
  }

  const thumbprint = value('FREE_ENTRA_CLIENT_CERT_THUMBPRINT')
  if (
    thumbprint !== null &&
    !/^[0-9a-fA-F]{64}$/.test(thumbprint.replaceAll(':', ''))
  )
    errors.push(
      'FREE_ENTRA_CLIENT_CERT_THUMBPRINT must be the SHA-256 certificate thumbprint (64 hex digits, colons allowed).',
    )

  const certificatePath = value('FREE_ENTRA_CLIENT_CERT_PATH')
  if (certificatePath !== null && !fileExists(certificatePath))
    errors.push(
      `FREE_ENTRA_CLIENT_CERT_PATH names ${certificatePath}, which does not exist on this host.`,
    )

  return errors
}

// The same substitution the nginx image's envsubst entrypoint applies to this
// template in development; the two environments render one shared file.
export function renderNginxLocations(template, values) {
  return template.replaceAll(/\$\{(STUDIO_BASE_PATH|FREE_STUDIO_UPSTREAM)\}/g, (
    _match,
    name,
  ) => values[name])
}

async function productionMain(args) {
  if (args.length > 0)
    throw new Error(`The production target takes no options: ${args.join(' ')}`)
  const dotEnv = loadDotEnv()
  if (dotEnv === null)
    throw new Error('Production needs the root .env file (see .env.example).')
  // Compose interpolation lets the process environment win over .env; validate
  // the same effective values.
  const environment = { ...dotEnv, ...process.env }
  const errors = validateProductionEnvironment(environment)
  if (errors.length > 0)
    throw new Error(['The .env deployment values are incomplete:', ...errors.map((error) => `  - ${error}`)].join('\n'))

  const rendered = renderNginxLocations(
    readFileSync(resolve(ROOT, NGINX_LOCATIONS_TEMPLATE), 'utf8'),
    {
      STUDIO_BASE_PATH: environment.STUDIO_BASE_PATH,
      FREE_STUDIO_UPSTREAM: `127.0.0.1:${STUDIO_PORT}`,
    },
  )
  mkdirSync(resolve(ROOT, '.nginx'), { recursive: true })
  writeFileSync(resolve(ROOT, RENDERED_NGINX_LOCATIONS), rendered)

  console.log(`Rendered ${RENDERED_NGINX_LOCATIONS} for the host nginx.`)
  console.log('Starting the production stack (waits for health checks)...\n')
  await awaitChild(
    spawn(
      'docker',
      [
        'compose',
        '-f',
        'compose.yaml',
        '-f',
        'compose.prod.yaml',
        'up',
        '--build',
        '-d',
        '--wait',
      ],
      { cwd: ROOT, stdio: 'inherit', shell: false },
    ),
  )
  if (process.exitCode !== 0) return
  console.log(`
The containers are healthy; migrations replayed before Studio started.
Host nginx checklist (once per configuration change):
  1. Make the FREE server block include the rendered file, for example:
       include ${resolve(ROOT, RENDERED_NGINX_LOCATIONS)};
  2. sudo nginx -t
  3. sudo systemctl reload nginx
Then verify: curl --fail ${environment.STUDIO_ORIGIN}${environment.STUDIO_BASE_PATH}/api/healthz`)
}

export async function main(args = process.argv.slice(2)) {
  const [target, ...rest] = args
  if (target === 'local') return localMain(rest)
  if (target === 'production') return productionMain(rest)
  throw new Error(
    'Usage: node scripts/free.mjs <local|production> — the target is always explicit.',
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
