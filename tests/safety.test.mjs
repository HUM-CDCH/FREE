// Safety boundaries that must hold without a running stack: destructive
// database operations refuse non-local targets, production configuration
// validates before anything starts, and both nginx environments consume the
// same proxy fragment.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  developmentComposeArguments,
  developmentComposeEnvironment,
  deriveDevProfile,
  parseDevOptions,
  renderNginxLocations,
  validateProductionEnvironment,
} from '../scripts/free.mjs'
import { ROOT } from './helpers.mjs'

function resetDatabase(databaseUrl) {
  return spawnSync(
    process.execPath,
    [
      resolve(ROOT, 'packages/db/node_modules/tsx/dist/cli.mjs'),
      resolve(ROOT, 'packages/db/src/reset-database.ts'),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
}

function renderDevelopmentCompose(profile, entraEnvironment = null) {
  const launchArguments = developmentComposeArguments(profile)
  const result = spawnSync(
    'docker',
    [
      ...launchArguments.slice(0, launchArguments.indexOf('up')),
      'config',
      '--format',
      'json',
    ],
    {
      cwd: ROOT,
      env: developmentComposeEnvironment(
        profile,
        process.env,
        Buffer.alloc(32, 8).toString('base64'),
        entraEnvironment,
      ),
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
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

test('db safety: reset refuses the Compose database hostname', () => {
  const result = resetDatabase(
    'postgresql://postgres:postgres@db:5432/free',
  )

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
  FREE_PARSING_POSTGRES_PASSWORD: 'c'.repeat(64),
  FREE_ENTRA_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  FREE_ENTRA_CLIENT_ID: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'b'.repeat(64),
  FREE_ENTRA_CLIENT_CERT_PATH: certificatePath,
})

test('production: a complete Entra deployment environment validates', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'free-prod-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
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

for (const gpu of [false, true]) test(`production: compose renders with GPU access ${gpu ? 'enabled' : 'disabled'}`, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'free-prod-compose-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const certificate = join(directory, 'client.pem')
  writeFileSync(certificate, 'not-a-real-key')
  const result = spawnSync(
    'docker',
    ['compose', '-f', 'compose.yaml', '-f', 'compose.prod.yaml',
      ...(gpu ? ['-f', 'compose.gpu.yaml'] : []), 'config', '--format', 'json'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...completeProductionEnvironment(certificate),
        COMPOSE_DISABLE_ENV_FILE: '1',
        FREE_GPU: 'auto',
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)
  assertOwnedParsingTopology(config, gpu)
  assert.equal(config.services.parsing_db.environment.POSTGRES_PASSWORD, 'c'.repeat(64))
  // Production keeps its host-managed nginx and has no mock identity provider.
  assert.equal(config.services.nginx, undefined)
  assert.equal(config.services['mock-oidc'], undefined)

})

function assertOwnedParsingTopology(config, gpu) {
  const services = config.services
  assert.equal(services.studio.environment.KEI_EXP_URL, 'http://parsing_service:8001')
  // Host-run Model Connections still resolve from Studio, independently of parsing.
  assert.ok(services.studio.extra_hosts?.some((host) => /^host\.docker\.internal[:=]host-gateway$/.test(host)),
    `studio.extra_hosts: ${JSON.stringify(services.studio.extra_hosts)}`)
  const expectedDatabase = services.parsing_migrate.environment.KEI_DATABASE_URL
  assert.match(expectedDatabase, /@parsing_db:5432\/kei$/)
  assert.deepEqual(services.parsing_migrate.command, ['kei-jobs', 'schema', '--apply'])
  assert.equal(services.parsing_migrate.depends_on.parsing_db.condition, 'service_healthy')
  for (const name of ['parsing_service', 'parsing_worker']) {
    const service = services[name]
    assert.equal(service.environment.KEI_DATABASE_URL, expectedDatabase)
    assert.equal(service.environment.KEI_RUNS, '/app/runs')
    assert.equal(service.environment.KEI_SLOT, 'slot-1')
    assert.equal(service.depends_on.parsing_migrate.condition, 'service_completed_successfully')
    assert.ok(service.volumes.some(({ source, target }) => source === 'parsing-runs' && target === '/app/runs'))
    assert.equal(service.ports, undefined, 'the unauthenticated service stays private')
    assert.equal(service.deploy?.resources?.reservations?.devices, undefined)
  }
  assert.equal(services.parsing_worker.restart, 'unless-stopped')
  assert.deepEqual(services.parsing_worker.command, ['kei-jobs', 'worker'])
  assert.equal(services.studio.depends_on.parsing_service.condition, 'service_healthy')
  assert.equal(services.studio.depends_on.extraction_model_init.condition, 'service_completed_successfully')
  assert.equal(services.extraction_model_init.depends_on.extraction_model.condition, 'service_healthy')
  assert.equal(services.extraction_model.environment.OLLAMA_NUM_PARALLEL, '1')
  assert.equal(services.extraction_model_init.environment.KEI_EXTRACT_MODEL, services.parsing_worker.environment.KEI_EXTRACT_MODEL)
  for (const name of ['parsing_db', 'extraction_model'])
    assert.equal(services[name].ports, undefined, `${name} stays private`)
  assert.equal(Boolean(services.ocr_model), gpu)
  assert.equal(Boolean(services.extraction_model.deploy?.resources?.reservations?.devices), gpu)
  if (gpu) {
    assert.equal(services.ocr_model.deploy.resources.reservations.devices[0].driver, 'nvidia')
    assert.equal(services.parsing_worker.depends_on.ocr_model.condition, 'service_healthy')
    assert.equal(services.ocr_model.ports, undefined)
  }
  assert.equal(config.volumes['postgres-data'].name.endsWith('_postgres-data'), true)
  assert.equal(config.volumes['parsing-runs'].name.endsWith('_parsing-runs'), true)
}

test('development: the owned parsing stack migrates before serving and restarts both source processes', () => {
  const config = renderDevelopmentCompose(deriveDevProfile(parseDevOptions([]), {}))
  assertOwnedParsingTopology(config, false)
  assert.equal(config.services.parsing_db.environment.POSTGRES_PASSWORD, 'kei')
  for (const name of ['parsing_service', 'parsing_worker']) {
    const watch = config.services[name].develop.watch
    const source = watch.find(({ action }) => action === 'sync+restart')
    assert.ok(source.path.replaceAll('\\', '/').endsWith('/prototypes/parsing_service/src'))
    assert.equal(source.target, '/app/src')
    assert.equal(source.initial_sync, true)
    for (const filename of ['pyproject.toml', 'uv.lock', 'Dockerfile'])
      assert.ok(watch.some(({ action, path }) => action === 'rebuild' && path.endsWith(`/${filename}`)))
  }
})

test('database tooling: package exposes only supported operator commands', () => {
  const scripts = JSON.parse(
    readFileSync(resolve(ROOT, 'packages/db/package.json'), 'utf8'),
  ).scripts

  for (const supported of [
    'contract:emit',
    'db:start',
    'db:reset',
    'db:init',
    'db:verify',
  ])
    assert.equal(typeof scripts[supported], 'string', supported)

  for (const unsupported of ['db:update', 'db:migrate', 'db:studio'])
    assert.equal(scripts[unsupported], undefined, unsupported)
})

test('development: mock and real Entra Compose profiles render exclusively', () => {
  const mockProfile = deriveDevProfile(parseDevOptions([]), {})
  const mockServices = renderDevelopmentCompose(mockProfile).services
  assert.deepEqual(mockServices['mock-oidc']?.profiles, ['mock-oidc'])
  assert.equal(
    mockServices.studio.depends_on['mock-oidc'].condition,
    'service_started',
  )
  assert.equal(mockServices.studio.depends_on['mock-oidc'].required, false)
  assert.equal(
    mockServices.studio.environment.FREE_ENTRA_MOCK_ISSUER,
    'http://mock-oidc:8080/dev',
  )
  assert.ok(
    mockServices['mock-oidc'].ports.some(
      ({ target, published }) =>
        target === 8080 && String(published) === '8444',
    ),
    'the active mock profile must publish its browser issuer',
  )

  const realProfile = deriveDevProfile(parseDevOptions(['--entra']), {})
  const certificate = resolve(ROOT, '.certs/studio.key')
  const realServices = renderDevelopmentCompose(realProfile, {
    FREE_ENTRA_TENANT_ID: '11111111-2222-4333-8444-555555555555',
    FREE_ENTRA_CLIENT_ID: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'b'.repeat(64),
    FREE_ENTRA_CLIENT_CERT_PATH: certificate,
  }).services
  assert.equal(realServices['mock-oidc'], undefined)
  assert.equal(realServices.studio.depends_on['mock-oidc'], undefined)
  assert.equal(
    realServices.studio.environment.FREE_ENTRA_MOCK_ISSUER,
    null,
  )
  assert.equal(
    realServices.studio.environment.FREE_ENTRA_MOCK_BROWSER_ISSUER,
    null,
  )
  assert.ok(
    Object.values(realServices).every((service) =>
      (service.ports ?? []).every(
        ({ published }) => String(published) !== '8444',
      ),
    ),
    'the real Entra topology must not bind the mock browser port',
  )
})

test('development: Studio watches shared configuration and rebuild-owned database inputs', () => {
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
  const databaseSource = watch.find(
    ({ path, action }) =>
      action === 'sync' &&
      path.replaceAll('\\', '/').endsWith('/packages/db'),
  )
  for (const rebuildOwnedInput of [
    'prisma-next.config.ts',
    'migrations/',
    'src/prisma/contract.prisma',
  ])
    assert.ok(
      databaseSource?.ignore.includes(rebuildOwnedInput),
      `${rebuildOwnedInput} must not be generically synced`,
    )
  const rebuildPaths = watch
    .filter(({ action }) => action === 'rebuild')
    .map(({ path }) => path.replaceAll('\\', '/'))
  for (const rebuildOwnedInput of [
    '/packages/db/prisma-next.config.ts',
    '/packages/db/src/prisma/contract.prisma',
    '/packages/db/migrations',
  ])
    assert.ok(
      rebuildPaths.some((path) => path.endsWith(rebuildOwnedInput)),
      `${rebuildOwnedInput} must rebuild the Studio image`,
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

test('proxy parity: the shared fragment renders and passes nginx -t for the host wrapper', (t) => {
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
  t.after(() => rmSync(directory, { recursive: true, force: true }))
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
