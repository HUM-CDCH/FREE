// Safety boundaries that must hold without a running stack: destructive
// database operations refuse non-local targets, production configuration
// validates before anything starts, and both nginx environments consume the
// same proxy fragment.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  developmentComposeEnvironment,
  devContainerEnvironment,
  renderNginxLocations,
  validateProductionEnvironment,
} from '../scripts/free.mjs'
import { ROOT } from './helpers.mjs'

function resetDatabase(databaseUrl) {
  return spawnSync(
    'pnpm',
    ['--filter', 'db', 'exec', 'tsx', 'src/reset-database.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      shell: true,
      timeout: 120_000,
    },
  )
}

test('db safety: reset refuses a remote database target', () => {
  const result = resetDatabase(
    'postgresql://postgres:secret@db.production.example.com:5432/free',
  )
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr + result.stdout,
    /Destructive database operations require/,
  )
})

test('db safety: reset refuses a local database that is not the dev database', () => {
  const result = resetDatabase('postgresql://postgres:postgres@127.0.0.1:5432/researchdata')
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr + result.stdout,
    /Destructive database operations require/,
  )
})

const completeProductionEnvironment = (certificatePath) => ({
  STUDIO_ORIGIN: 'https://free.example.org',
  STUDIO_BASE_PATH: '/free',
  FREE_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'),
  FREE_POSTGRES_PASSWORD: 'a'.repeat(64),
  FREE_ENTRA_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  FREE_ENTRA_CLIENT_ID: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'b'.repeat(64),
  FREE_ENTRA_CLIENT_CERT_PATH: certificatePath,
})

test('production: a complete Entra deployment environment validates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'free-prod-test-'))
  const certificate = join(directory, 'client.pem')
  writeFileSync(certificate, 'not-a-real-key')
  assert.deepEqual(
    validateProductionEnvironment(completeProductionEnvironment(certificate)),
    [],
  )
})

test('production: missing or weak values are rejected before startup', () => {
  const errors = validateProductionEnvironment({
    STUDIO_ORIGIN: 'http://insecure.example.org',
    STUDIO_BASE_PATH: '/free',
    FREE_SESSION_SECRET: 'short',
    FREE_POSTGRES_PASSWORD: 'password',
  })
  assert.ok(errors.some((error) => error.includes('STUDIO_ORIGIN')))
  assert.ok(errors.some((error) => error.includes('FREE_SESSION_SECRET')))
  assert.ok(errors.some((error) => error.includes('FREE_POSTGRES_PASSWORD')))
  assert.ok(errors.some((error) => error.includes('FREE_ENTRA_TENANT_ID')))
})

test('production: the compose overlay renders with a valid environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'free-prod-compose-'))
  const certificate = join(directory, 'client.pem')
  writeFileSync(certificate, 'not-a-real-key')
  const result = spawnSync(
    'docker',
    ['compose', '-f', 'compose.yaml', '-f', 'compose.prod.yaml', 'config'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...completeProductionEnvironment(certificate),
        COMPOSE_DISABLE_ENV_FILE: '1',
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /studio:/)
  // Production has no containerized nginx and no mock identity provider.
  assert.ok(!/^\s{2}nginx:/m.test(result.stdout), 'nginx stays on the host')
  assert.ok(!result.stdout.includes('mock-oidc'), 'the mock cannot reach production')
})

test('Dev Container: sibling PostgreSQL and mock OIDC topology renders intact', () => {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      '.devcontainer/compose.yaml',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)

  const { services } = JSON.parse(result.stdout)
  assert.ok(services.workspace)
  assert.ok(services.db)
  assert.ok(
    services.workspace.volumes.some(
      ({ target }) => target === '/workspaces/FREE',
    ),
    'the repository must remain mounted at /workspaces/FREE',
  )
  assert.ok(
    services.db.volumes.some(
      ({ type, target }) =>
        type === 'volume' && target === '/var/lib/postgresql/data',
    ),
    'PostgreSQL must retain its data volume',
  )
  assert.equal(
    services['mock-oidc']?.image,
    'ghcr.io/navikt/mock-oauth2-server:2.2.1',
  )
  assert.deepEqual(
    {
      db: services.workspace.depends_on.db.condition,
      mockOidc: services.workspace.depends_on['mock-oidc'].condition,
    },
    { db: 'service_healthy', mockOidc: 'service_started' },
  )

  const oidcConfiguration = JSON.parse(
    services['mock-oidc'].environment.JSON_CONFIG,
  )
  assert.equal(oidcConfiguration.interactiveLogin, false)
  assert.equal(oidcConfiguration.tokenCallbacks[0].issuerId, 'dev')
  assert.deepEqual(
    oidcConfiguration.tokenCallbacks[0].requestMappings[0].claims,
    {
      tid: '00000000-0000-4000-8000-000000000001',
      oid: '00000000-0000-4000-8000-000000000002',
      name: 'Development Researcher',
    },
  )
  assert.ok(
    services['mock-oidc'].ports.some(
      ({ host_ip: hostIp, target, published }) =>
        hostIp === '127.0.0.1' &&
        target === 8080 &&
        String(published) === '8444',
    ),
    'mock OIDC must publish host loopback port 8444 to container port 8080',
  )

  const devContainer = JSON.parse(
    readFileSync(resolve(ROOT, '.devcontainer/devcontainer.json'), 'utf8'),
  )
  assert.deepEqual(devContainer.forwardPorts, [5173, 8055, 8444])
  assert.equal(devContainer.portsAttributes['8444'].label, 'Mock OIDC')
})

test('Dev Container: direct Studio launcher uses sibling and browser OIDC issuers', () => {
  const environment = devContainerEnvironment(
    {
      PATH: 'kept',
      STUDIO_ORIGIN: 'https://deployment.example',
      STUDIO_BASE_PATH: '/deployment',
      FREE_ENTRA_REAL: '1',
      FREE_ENTRA_MOCK_ISSUER: 'https://deployment.example/issuer',
      FREE_ENTRA_MOCK_BROWSER_ISSUER: 'https://deployment.example/issuer',
    },
    'development-session-secret',
  )

  assert.equal(environment.PATH, 'kept')
  assert.equal(environment.STUDIO_ORIGIN, 'http://localhost:5173')
  assert.equal(environment.STUDIO_BASE_PATH, '/free')
  assert.equal(environment.FREE_SESSION_SECRET, 'development-session-secret')
  assert.equal(environment.FREE_ENTRA_REAL, '0')
  assert.equal(
    environment.FREE_ENTRA_MOCK_ISSUER,
    'http://mock-oidc:8080/dev',
  )
  assert.equal(
    environment.FREE_ENTRA_MOCK_BROWSER_ISSUER,
    'http://localhost:8444/dev',
  )
})

test('development: Studio watches the shared configuration package and rebuilds its manifest', () => {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'compose.yaml',
      '-f',
      'compose.override.yaml',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: ROOT,
      env: developmentComposeEnvironment(
        undefined,
        process.env,
        Buffer.alloc(32, 8).toString('base64'),
      ),
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const watch = JSON.parse(result.stdout).services.studio.develop.watch
  const sharedSource = watch.find(
    ({ path, action }) =>
      action === 'sync' &&
      path.replaceAll('\\', '/').endsWith('/packages/studio-configuration'),
  )
  assert.deepEqual(
    {
      target: sharedSource?.target,
      initialSync: sharedSource?.initial_sync,
      ignore: sharedSource?.ignore,
    },
    {
      target: '/workspace/packages/studio-configuration',
      initialSync: true,
      ignore: ['package.json', 'node_modules/'],
    },
  )
  assert.ok(
    watch.some(
      ({ path, action }) =>
        action === 'rebuild' &&
        path
          .replaceAll('\\', '/')
          .endsWith('/packages/studio-configuration/package.json'),
    ),
    'the shared configuration manifest must rebuild the Studio image',
  )
})

test('image: the shared configuration manifest precedes Studio dependency installation', () => {
  const dockerfile = readFileSync(
    resolve(ROOT, 'prototypes/studio/Dockerfile'),
    'utf8',
  )
  const manifest = dockerfile.indexOf(
    'COPY packages/studio-configuration/package.json packages/studio-configuration/',
  )
  const install = dockerfile.indexOf('pnpm install --frozen-lockfile')
  const source = dockerfile.indexOf('COPY . .')
  assert.ok(manifest >= 0, 'the image must copy the shared package manifest')
  assert.ok(
    manifest < install,
    'the shared package manifest must invalidate the dependency layer',
  )
  assert.ok(
    install < source,
    'workspace source must remain outside the manifest-first dependency layer',
  )
})

test('proxy parity: the shared fragment renders and passes nginx -t for the host wrapper', () => {
  const template = readFileSync(
    resolve(ROOT, 'docker/nginx/free-studio-locations.inc.template'),
    'utf8',
  )
  const rendered = renderNginxLocations(template, {
    STUDIO_BASE_PATH: '/free',
    FREE_STUDIO_UPSTREAM: '127.0.0.1:5173',
  })
  assert.match(rendered, /location = \/free|location \/free|\/free/)
  assert.ok(!rendered.includes('${'), 'no unrendered placeholders')

  const directory = mkdtempSync(join(tmpdir(), 'free-nginx-test-'))
  writeFileSync(join(directory, 'free-studio-locations.conf'), rendered)
  writeFileSync(
    join(directory, 'wrapper.conf'),
    [
      // The http-level map the fragment documents for its including wrapper.
      'map $http_upgrade $free_connection_upgrade {',
      '  default upgrade;',
      "  '' close;",
      '}',
      'server {',
      '  listen 8080;',
      '  server_name free.example.org;',
      '  include /etc/nginx/free-test/free-studio-locations.conf;',
      '}',
      '',
    ].join('\n'),
  )
  const result = spawnSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${directory}:/etc/nginx/free-test:ro`,
      '-v', `${directory}/wrapper.conf:/etc/nginx/conf.d/wrapper.conf:ro`,
      'nginx:alpine', 'nginx', '-t',
    ],
    { encoding: 'utf8', timeout: 300_000 },
  )
  assert.equal(result.status, 0, result.stderr)
})

test('no committed secrets: tracked files carry no credential material', () => {
  const listing = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  const files = listing.stdout.split('\n').filter(Boolean)
  const suspicious = files.filter((file) => /(^|\/)\.env$|\.pem$|\.key$|\.pfx$/.test(file))
  assert.deepEqual(suspicious, [])
})
