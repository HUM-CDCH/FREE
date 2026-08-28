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
    /Only the local development database named "free" is accepted/,
  )
})

test('db safety: reset refuses a local database that is not the dev database', () => {
  const result = resetDatabase('postgresql://postgres:postgres@127.0.0.1:5432/researchdata')
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr + result.stdout,
    /Only the local development database named "free" is accepted/,
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
