// The FREE launcher: one entry point with an explicit target.
//
//   node scripts/free.mjs local [--entra] [--wifi] [--host=<ip>] [--firewall=on|off]
//   node scripts/free.mjs production
//
// Compose owns the topology (compose.yaml plus compose.override.yaml or
// compose.prod.yaml); this script only prepares what Compose cannot.
// `local` prepares mkcert certificates, the optional Windows Wi-Fi firewall
// rule, and the per-machine environment values. `production`
// validates .env before anything starts, renders the host nginx include from
// the shared template, and starts the production overlay detached, waiting
// for health. Both targets build before stopping the old schema consumers;
// Compose then runs the migration before starting their replacements.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { validateSharedStudioConfiguration } from 'studio-configuration'
import {
  ensureDevelopmentSessionSecret as ensureSessionSecretFile,
} from './development-session-secret.mjs'
import { validateComposeVersion } from './compose-version.mjs'

export { validateComposeVersion } from './compose-version.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const NGINX_PORT = 8443
const MOCK_OIDC_PORT = 8444
const FIREWALL_RULE = 'FREE Studio Wi-Fi development'
const WINDOWS = process.platform === 'win32'
const STUDIO_PORT = 5173
const DEVELOPMENT_SESSION_SECRET = '.dev/session-secret'
const NGINX_LOCATIONS_TEMPLATE = 'docker/nginx/free-studio-locations.inc.template'
const RENDERED_NGINX_LOCATIONS = '.nginx/free-studio-locations.conf'
const LOCAL_ENTRA_FIELDS = Object.freeze([
  'FREE_ENTRA_TENANT_ID',
  'FREE_ENTRA_CLIENT_ID',
  'FREE_ENTRA_CLIENT_CERT_THUMBPRINT',
  'FREE_ENTRA_CLIENT_CERT_PATH',
])
const LOCAL_ENTRA_INVALID_MESSAGES = Object.freeze({
  FREE_ENTRA_TENANT_ID: 'FREE_ENTRA_TENANT_ID must be a UUID.',
  FREE_ENTRA_CLIENT_ID: 'FREE_ENTRA_CLIENT_ID must be a UUID.',
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT:
    'FREE_ENTRA_CLIENT_CERT_THUMBPRINT must be the SHA-256 certificate thumbprint (64 hex digits, colons allowed).',
})

function onOff(value, option) {
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`${option} must be on or off.`)
}

export function parseDevOptions(args) {
  // pnpm forwards the optional argument separator to the script.
  if (args[0] === '--') args = args.slice(1)
  const options = {
    entra: false,
    wifi: false,
    host: null,
    firewall: true,
    revokeWifiAccess: false,
  }
  for (const argument of args) {
    if (argument === '--entra') options.entra = true
    else if (argument === '--wifi') options.wifi = true
    else if (argument.startsWith('--firewall='))
      options.firewall = onOff(argument.slice(11), '--firewall')
    else if (argument.startsWith('--host=')) {
      options.host = argument.slice(7)
      options.wifi = true
    } else if (argument === '--revoke-wifi-access')
      options.revokeWifiAccess = true
    else throw new Error(`Unknown development option: ${argument}`)
  }
  if (options.revokeWifiAccess && args.length !== 1)
    throw new Error('--revoke-wifi-access cannot be combined with startup options.')
  if (
    options.entra &&
    (options.wifi || args.some((argument) => argument.startsWith('--firewall=')))
  )
    throw new Error(
      '--entra cannot be combined with --wifi, --host, or --firewall.',
    )
  return options
}

export function parseProductionOptions(args) {
  if (args[0] === '--') args = args.slice(1)
  if (args.length > 0) throw new Error(`Unknown production option: ${args[0]}`)
}

function privateIpv4(address) {
  if (isIP(address) !== 4) return false
  const parts = address.split('.').map(Number)
  return (
    parts.length === 4 &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  )
}

export function selectWifiAddress(interfaces = networkInterfaces()) {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        ({ address, family, internal }) =>
          !internal &&
          (family === 'IPv4' || family === 4) &&
          privateIpv4(address),
      )
      .map(({ address }) => ({
        address,
        preferred: /wi-?fi|wlan|wireless/i.test(name),
      })),
  )
  candidates.sort((left, right) => Number(right.preferred) - Number(left.preferred))
  if (candidates.length === 0)
    throw new Error(
      'No private IPv4 network address was found. Connect to Wi-Fi or pass --host=<private-ip>.',
    )
  return candidates[0].address
}

export function deriveDevProfile(options, interfaces = networkInterfaces()) {
  if (options.host !== null && !privateIpv4(options.host))
    throw new Error('--host must be a private IPv4 address.')
  const host = options.wifi
    ? (options.host ?? selectWifiAddress(interfaces))
    : 'localhost'
  return {
    ...options,
    host,
    origin: `https://${host}:${NGINX_PORT}`,
    nginxBind: options.wifi ? '0.0.0.0' : '127.0.0.1',
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: false,
    timeout: options.timeout,
  })
  if (result.error && !options.allowFailure) throw result.error
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`${command} ${args.join(' ')} failed.`)
  return result
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function firewallRuleExists() {
  if (!WINDOWS) return true
  const script = `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`
  return (
    run('powershell.exe', ['-NoProfile', '-Command', script], {
      allowFailure: true,
      capture: true,
    }).status === 0
  )
}

function firewallRuleAllows(ports) {
  if (!WINDOWS) return true
  const contained = ports
    .map((port) => `$ports.LocalPort -contains '${port}'`)
    .join(' -and ')
  const script = `$rule = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue; if (-not $rule) { exit 1 }; $ports = $rule | Get-NetFirewallPortFilter; if (${contained}) { exit 0 } else { exit 1 }`
  return (
    run('powershell.exe', ['-NoProfile', '-Command', script], {
      allowFailure: true,
      capture: true,
    }).status === 0
  )
}

function elevatedPowerShell(script) {
  const encoded = encodedPowerShell(script)
  const launcher = `$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-EncodedCommand','${encoded}') -Wait -PassThru; exit $process.ExitCode`
  return run('powershell.exe', ['-NoProfile', '-Command', launcher], {
    allowFailure: true,
  }).status
}

function ensureWifiFirewall(ports) {
  if (!WINDOWS || firewallRuleAllows(ports)) return
  console.log(
    `\nWindows will ask for permission to expose Studio ports ${ports.join(' and ')} on private Wi-Fi.`,
  )
  const script = `
$existing = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue
if ($existing) { Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' }
New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Description 'FREE Studio development access from the private local subnet.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${ports.join(',')} -Profile Private -RemoteAddress LocalSubnet | Out-Null
`
  if (elevatedPowerShell(script) !== 0 || !firewallRuleAllows(ports))
    throw new Error(
      'Wi-Fi access needs the Windows Firewall approval. Accept the UAC prompt or rerun with --firewall=off if policy is managed elsewhere.',
    )
}

function revokeWifiFirewall() {
  if (!WINDOWS) {
    console.log('Automatic firewall revocation is only available on Windows.')
    return
  }
  if (!firewallRuleExists()) {
    console.log('The FREE Studio Wi-Fi firewall rule is already absent.')
    return
  }
  const script = `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue`
  if (elevatedPowerShell(script) !== 0 || firewallRuleExists())
    throw new Error('Windows Firewall access could not be revoked.')
  console.log('Revoked FREE Studio access from the private local subnet.')
}

export function ensureCertificates(
  profile = deriveDevProfile(parseDevOptions([]), {}),
) {
  const certificate = resolve(ROOT, '.certs', 'studio.crt')
  const key = resolve(ROOT, '.certs', 'studio.key')
  // A Wi-Fi run must cover the selected private address, so it regenerates.
  if (!profile.wifi && existsSync(certificate) && existsSync(key)) return
  mkdirSync(resolve(ROOT, '.certs'), { recursive: true })
  const names = ['localhost', '127.0.0.1', '::1']
  if (profile.wifi) names.push(profile.host)
  const generated = run(
    'mkcert',
    ['-cert-file', certificate, '-key-file', key, ...names],
    { allowFailure: true },
  )
  if (generated.error?.code === 'ENOENT' || generated.status !== 0)
    throw new Error(
      'mkcert could not generate .certs/studio.crt. Install mkcert and run `mkcert -install` once.',
    )
}

// Development sessions outlive the dev server. Without a persisted secret the
// Studio server generates one per boot, so every restart silently invalidates
// the Researcher's session cookie. This is per-machine generated material, like
// the mkcert certificates above, never a shared constant: `--wifi` publishes
// the entry point to the local subnet, where a known secret would be forgeable.
export function ensureDevelopmentSessionSecret(
  file = resolve(ROOT, DEVELOPMENT_SESSION_SECRET),
) {
  return ensureSessionSecretFile(file)
}

function ensureCompatibleCompose() {
  const version = run('docker', ['compose', 'version', '--short'], {
    capture: true,
  })
  validateComposeVersion(version.stdout)
}

function printReady(profile) {
  console.log(`\nStarting FREE at ${profile.origin}/free`)
  console.log(`  network: ${profile.wifi ? 'private Wi-Fi' : 'this device only'}`)
  console.log(
    profile.entra
      ? '  identity: real Microsoft Entra tenant'
      : '  identity: mock OIDC service on 127.0.0.1:8444',
  )
  if (profile.wifi) {
    const caroot = run('mkcert', ['-CAROOT'], {
      capture: true,
      allowFailure: true,
    })
    if (caroot.status === 0)
      console.log(`  phone trust: install the mkcert root CA from ${caroot.stdout.trim()}`)
  }
  console.log('Press Ctrl+C to stop the stack.\n')
  console.log('Phoenix model-call traces: http://localhost:6006 (loopback only).')
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
export function effectiveLocalEnvironment(
  environment = process.env,
  dotEnvironment = loadDotEnv(),
) {
  return {
    ...(dotEnvironment ?? {}),
    ...Object.fromEntries(
      Object.entries(environment).filter(([, value]) => value !== undefined),
    ),
  }
}

function inspectLocalEntraEnvironment(environment, fileExists) {
  const shared = validateSharedStudioConfiguration(environment)
  const issues = shared.issues.filter(({ field }) =>
    LOCAL_ENTRA_FIELDS.includes(field),
  )
  const errors = issues.map(({ field, code, message }) =>
    code === 'required'
      ? `${field} is required in the environment or .env.`
      : (LOCAL_ENTRA_INVALID_MESSAGES[field] ?? message),
  )
  const certificatePath = shared.values.FREE_ENTRA_CLIENT_CERT_PATH
  if (
    certificatePath !== undefined &&
    !fileExists(resolve(ROOT, certificatePath))
  )
    errors.push(
      `FREE_ENTRA_CLIENT_CERT_PATH names ${certificatePath}, which does not exist on this host.`,
    )
  return { errors, values: shared.values }
}

export function validateLocalEntraEnvironment(
  environment,
  fileExists = existsSync,
) {
  return inspectLocalEntraEnvironment(environment, fileExists).errors
}

export function loadLocalEntraEnvironment(
  environment = process.env,
  dotEnvironment = loadDotEnv(),
  fileExists = existsSync,
) {
  const effectiveEnvironment = effectiveLocalEnvironment(
    environment,
    dotEnvironment,
  )
  const { errors, values } = inspectLocalEntraEnvironment(
    effectiveEnvironment,
    fileExists,
  )
  if (errors.length > 0)
    throw new Error(
      `Real Entra local configuration is invalid:\n- ${errors.join('\n- ')}`,
    )
  return Object.fromEntries(
    LOCAL_ENTRA_FIELDS.map((field) => [field, values[field]]),
  )
}

export function parsingGpuComposeArguments(environment = process.env, execute = run) {
  const mode = environment.FREE_GPU || 'auto'
  if (!['auto', 'off', 'required'].includes(mode))
    throw new Error('FREE_GPU must be auto, off, or required.')
  if (mode === 'off') return []
  const probe = execute('docker', [
    'run', '--rm', '--gpus', 'all',
    'ubuntu:24.04', 'nvidia-smi', '-L',
  ], { capture: true, allowFailure: true, timeout: 60_000 })
  if (probe.status === 0 && /GPU \d+:/.test(probe.stdout ?? '')) {
    console.log('Models: NVIDIA GPU available; starting the OCR and extraction vLLM servers.')
    return ['-f', 'compose.gpu.yaml']
  }
  if (mode === 'required')
    throw new Error(`GPU access was required but Docker GPU access failed: ${probe.stderr || probe.error || 'no GPU found'}`)
  console.log('Models: Docker GPU unavailable; native PDFs are available. Scanned PDFs and extraction require the GPU model servers. ' +
    (probe.stderr?.trim() || probe.error?.message || 'No NVIDIA GPU found.'))
  return []
}

export function developmentComposeFiles(profile) {
  return [
    'compose.yaml',
    'compose.override.yaml',
    ...(profile.entra ? ['compose.entra.yaml'] : []),
  ]
}

export function developmentComposeArguments(profile, gpuArguments = []) {
  return [
    'compose',
    ...(!profile.entra ? ['--profile', 'mock-oidc'] : []),
    ...developmentComposeFiles(profile).flatMap((file) => ['-f', file]),
    ...gpuArguments,
    // Compose rejects --no-build with --watch. The build step has already
    // produced every image, and up builds only images that are missing.
    'up',
    '--watch',
  ]
}

export function developmentComposeEnvironment(
  profile = deriveDevProfile(parseDevOptions([]), {}),
  environment = process.env,
  sessionSecret = ensureDevelopmentSessionSecret(),
  entraEnvironment = null,
) {
  if (profile.entra !== (entraEnvironment !== null))
    throw new Error(
      profile.entra
        ? 'The real Entra profile requires validated Entra configuration.'
        : 'Entra configuration cannot be applied to the mock OIDC profile.',
    )

  const composeEnvironment = { ...environment }
  for (const field of Object.keys(composeEnvironment))
    if (field.startsWith('FREE_ENTRA_')) delete composeEnvironment[field]
  delete composeEnvironment.COMPOSE_PROFILES
  delete composeEnvironment.FREE_MOCK_OIDC_BIND

  Object.assign(composeEnvironment, {
    // Deployment values may coexist in the root .env. Compose development is
    // deliberately self-contained; only host-run tooling consumes its
    // DATABASE_URL.
    COMPOSE_DISABLE_ENV_FILE: '1',
    FREE_GPU: environment.FREE_GPU || 'auto',
    FREE_NGINX_PORT: String(NGINX_PORT),
    FREE_POSTGRES_PASSWORD: 'postgres',
    // Studio's entrypoint creates kei's role with it; kei's worker connects with it.
    FREE_KEI_POSTGRES_PASSWORD: 'kei-development',
    FREE_SESSION_SECRET: sessionSecret,
    STUDIO_BASE_PATH: '/free',
    STUDIO_ORIGIN: profile.origin,
    FREE_NGINX_BIND: profile.nginxBind,
    FREE_ENTRA_REAL: profile.entra ? '1' : '0',
  })
  if (profile.entra) Object.assign(composeEnvironment, entraEnvironment)
  else
    Object.assign(composeEnvironment, {
      FREE_MOCK_OIDC_BIND: profile.nginxBind,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: `http://${profile.host}:${MOCK_OIDC_PORT}/dev`,
    })
  return composeEnvironment
}

function awaitChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise(code ?? 1))
  })
}

// Build failures leave the current deployment serving. Once images exist,
// quiesce both schema consumers before Compose runs the migration dependency.
export async function startComposeStack(upArguments, environment, start = spawn) {
  const compose = upArguments.slice(0, upArguments.indexOf('up'))
  for (const args of [
    [...compose, 'build'],
    [...compose, 'stop', '--timeout', '60', 'studio', 'parsing_service', 'parsing_worker'],
    upArguments,
  ]) {
    const status = await awaitChild(start('docker', args, {
      cwd: ROOT,
      env: environment,
      stdio: 'inherit',
      shell: false,
    }))
    if (status !== 0) return status
  }
  return 0
}

async function localMain(args) {
  loadRootDatabaseUrl()
  const options = parseDevOptions(args)
  if (options.revokeWifiAccess) {
    revokeWifiFirewall()
    return
  }
  const profile = deriveDevProfile(options)
  const entraEnvironment = profile.entra
    ? loadLocalEntraEnvironment()
    : null
  // Validate the real tenant values and certificate before the first Docker
  // command, including the Compose version preflight.
  ensureCompatibleCompose()
  ensureCertificates(profile)
  const sessionSecret = ensureDevelopmentSessionSecret()
  // The mock OIDC port must open with nginx so a phone can follow the
  // sign-in redirect.
  if (profile.wifi && profile.firewall)
    ensureWifiFirewall([NGINX_PORT, MOCK_OIDC_PORT])
  printReady(profile)

  process.exitCode = await startComposeStack(
    developmentComposeArguments(profile, parsingGpuComposeArguments()),
    developmentComposeEnvironment(
      profile,
      process.env,
      sessionSecret,
      entraEnvironment,
    ),
  )
}

// Fail before any container starts, with every problem reported at once. The
// Studio server re-validates the same values at boot; this pass exists so a
// misconfigured deployment stops here instead of in a container restart loop.
export function validateProductionEnvironment(
  environment,
  fileExists = existsSync,
) {
  const errors = []
  const shared = validateSharedStudioConfiguration(environment)
  const invalidMessages = {
    STUDIO_ORIGIN:
      'STUDIO_ORIGIN must be a canonical HTTPS origin with no path, query, fragment, or credentials.',
    STUDIO_BASE_PATH:
      'STUDIO_BASE_PATH must be a non-root canonical path such as /free, without a trailing slash. The shipped nginx behavior requires a non-root base path.',
    FREE_SESSION_SECRET:
      'FREE_SESSION_SECRET must be canonical base64 decoding to at least 32 bytes (openssl rand -base64 32).',
    FREE_ENTRA_TENANT_ID: 'FREE_ENTRA_TENANT_ID must be a UUID.',
    FREE_ENTRA_CLIENT_ID: 'FREE_ENTRA_CLIENT_ID must be a UUID.',
    FREE_ENTRA_CLIENT_CERT_THUMBPRINT:
      'FREE_ENTRA_CLIENT_CERT_THUMBPRINT must be the SHA-256 certificate thumbprint (64 hex digits, colons allowed).',
  }
  const appendSharedIssue = (field) => {
    const issue = shared.issues.find((candidate) => candidate.field === field)
    if (issue === undefined) return false
    errors.push(
      issue.code === 'required'
        ? `${field} is required in .env.`
        : invalidMessages[field] ?? issue.message,
    )
    return true
  }

  if (
    !appendSharedIssue('STUDIO_ORIGIN') &&
    new URL(shared.values.STUDIO_ORIGIN).protocol !== 'https:'
  )
    errors.push(
      'STUDIO_ORIGIN must be a canonical HTTPS origin with no path, query, fragment, or credentials.',
    )

  if (
    !appendSharedIssue('STUDIO_BASE_PATH') &&
    shared.values.STUDIO_BASE_PATH === '/'
  )
    errors.push(
      'STUDIO_BASE_PATH must be a non-root canonical path such as /free, without a trailing slash. The shipped nginx behavior requires a non-root base path.',
    )

  appendSharedIssue('FREE_SESSION_SECRET')

  for (const field of ['FREE_POSTGRES_PASSWORD', 'FREE_KEI_POSTGRES_PASSWORD']) {
    const password = environment[field]
    if (password === undefined || password === '')
      errors.push(`${field} is required in .env.`)
    else if (!/^[0-9a-fA-F]{32,}$/.test(password))
      errors.push(`${field} must be a generated hexadecimal password (openssl rand -hex 32).`)
  }

  appendSharedIssue('FREE_ENTRA_TENANT_ID')
  appendSharedIssue('FREE_ENTRA_CLIENT_ID')
  appendSharedIssue('FREE_ENTRA_CLIENT_CERT_THUMBPRINT')

  if (
    !appendSharedIssue('FREE_ENTRA_CLIENT_CERT_PATH') &&
    !fileExists(shared.values.FREE_ENTRA_CLIENT_CERT_PATH)
  )
    errors.push(
      `FREE_ENTRA_CLIENT_CERT_PATH names ${shared.values.FREE_ENTRA_CLIENT_CERT_PATH}, which does not exist on this host.`,
    )

  const nginx = environment.FREE_NGINX || 'host'
  if (!['host', 'container'].includes(nginx))
    errors.push('FREE_NGINX must be host or container.')
  // The bundled nginx terminates TLS itself, so its certificate and key must
  // be on this host; the host nginx keeps them in its own configuration.
  if (nginx === 'container')
    for (const field of ['FREE_TLS_CERT_PATH', 'FREE_TLS_KEY_PATH']) {
      const path = environment[field]
      if (path === undefined || path === '')
        errors.push(`${field} is required in .env when FREE_NGINX=container.`)
      else if (!fileExists(path))
        errors.push(`${field} names ${path}, which does not exist on this host.`)
    }

  return errors
}

// Where TLS terminates: the host-managed nginx (default) or the bundled nginx
// container of compose.nginx.yaml for hosts without one.
export function productionComposeFiles(environment) {
  return [
    'compose.yaml',
    'compose.prod.yaml',
    ...(environment.FREE_NGINX === 'container' ? ['compose.nginx.yaml'] : []),
  ]
}

export function productionComposeArguments(environment, gpuArguments = []) {
  return [
    'compose',
    ...productionComposeFiles(environment).flatMap((file) => ['-f', file]),
    ...gpuArguments,
    'up',
    '--no-build',
    '-d',
    '--wait',
  ]
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
  parseProductionOptions(args)
  const dotEnv = loadDotEnv()
  if (dotEnv === null)
    throw new Error(
      'Production needs the root .env file described in docs/operations/deployment.md.',
    )
  ensureCompatibleCompose()
  // Compose interpolation lets the process environment win over .env; validate
  // the same effective values.
  const environment = { ...dotEnv, ...process.env }
  const errors = validateProductionEnvironment(environment)
  if (errors.length > 0)
    throw new Error(['The .env deployment values are incomplete:', ...errors.map((error) => `  - ${error}`)].join('\n'))

  const hostNginx = environment.FREE_NGINX !== 'container'
  if (hostNginx) {
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
  }

  console.log('Starting the production stack (waits for health checks)...\n')
  process.exitCode = await startComposeStack(
    productionComposeArguments(environment, parsingGpuComposeArguments(environment)),
    environment,
  )
  if (process.exitCode !== 0) return
  console.log('Phoenix model-call traces: http://localhost:6006 (loopback only).')
  if (!hostNginx) {
    console.log(`
The services started and configured health checks passed; the bundled nginx terminates TLS.
Verify: curl --fail ${environment.STUDIO_ORIGIN}${environment.STUDIO_BASE_PATH}/api/healthz`)
    return
  }
  console.log(`
The services started and configured health checks passed; migrations replayed before Studio started.
Host nginx checklist (once per configuration change):
  1. Make the FREE server block include the rendered file, for example:
       include ${resolve(ROOT, RENDERED_NGINX_LOCATIONS)};
     (see docs/operations/deployment.md for the full wrapper example)
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
