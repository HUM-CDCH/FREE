import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  SHARED_STUDIO_CONFIGURATION_FIELDS,
  validateSharedStudioConfiguration,
} from 'studio-configuration'
import {
  developmentComposeArguments,
  developmentComposeEnvironment,
  developmentComposeFiles,
  parsingGpuComposeArguments,
  productionComposeFiles,
  deriveDevProfile,
  effectiveLocalEnvironment,
  ensureDevelopmentSessionSecret,
  loadLocalEntraEnvironment,
  parseDevOptions,
  renderNginxLocations,
  selectWifiAddress,
  startComposeStack,
  validateComposeVersion,
  validateLocalEntraEnvironment,
  validateProductionEnvironment,
} from './free.mjs'

const temporaryDirectories = []

it('enables the owned OCR model only with Docker GPU access', () => {
  const profile = deriveDevProfile(parseDevOptions([]), {})
  assert.equal(developmentComposeEnvironment(profile, {}, 'test-secret').FREE_GPU, 'auto')
  assert.deepEqual(parsingGpuComposeArguments({ FREE_GPU: 'off' }, () => {
    assert.fail('Disabled GPU access must skip the probe')
  }), [])
  assert.throws(() => parsingGpuComposeArguments({ FREE_GPU: 'maybe' }), /FREE_GPU must be/)
  const gpu = parsingGpuComposeArguments({}, (command, args, options) => {
    assert.equal(command, 'docker')
    assert.ok(args.includes('--gpus'))
    assert.equal(options.timeout, 60_000)
    return { status: 0, stdout: 'GPU 0: NVIDIA (UUID: GPU-test)' }
  })
  assert.deepEqual(gpu, ['-f', 'compose.gpu.yaml'])
  const args = developmentComposeArguments(profile, gpu)
  assert.ok(args.indexOf('compose.gpu.yaml') < args.indexOf('up'))
  for (const result of [{ status: 1 }, { status: null, error: new Error('timeout') }, { status: 0, stdout: '' }]) {
    assert.deepEqual(parsingGpuComposeArguments({}, () => result), [])
    assert.throws(() => parsingGpuComposeArguments({ FREE_GPU: 'required' }, () => result), /GPU access was required/)
  }
})

function temporarySecretFile() {
  const directory = mkdtempSync(join(tmpdir(), 'free-launcher-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', 'session-secret')
}

function temporaryFile(name) {
  const directory = mkdtempSync(join(tmpdir(), 'free-launcher-'))
  temporaryDirectories.push(directory)
  const file = join(directory, name)
  writeFileSync(file, 'test certificate')
  return file
}

after(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

const interfaces = {
  Ethernet: [
    { address: '10.20.30.40', family: 'IPv4', internal: false },
  ],
  'Wi-Fi': [
    { address: '192.168.1.149', family: 'IPv4', internal: false },
  ],
}

const validEntraEnvironment = (certificatePath) => ({
  FREE_ENTRA_TENANT_ID: '10000000-0000-4000-8000-000000000001',
  FREE_ENTRA_CLIENT_ID: '10000000-0000-4000-8000-000000000002',
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'ab:'.repeat(31) + 'ab',
  FREE_ENTRA_CLIENT_CERT_PATH: certificatePath,
})

describe('ordered Compose startup', () => {
  const local = developmentComposeArguments(deriveDevProfile(parseDevOptions([]), {}))
  const production = ['compose', '-f', 'compose.yaml', '-f', 'compose.prod.yaml', 'up', '--no-build', '-d', '--wait']

  it('never asks development Compose for --no-build, which it rejects with --watch', () => {
    // `docker compose up --no-build --watch` fails: "--no-build and --watch are incompatible".
    assert.ok(local.includes('--watch') && !local.includes('--no-build'))
  })

  for (const up of [local, production]) {
    it(`builds before stopping schema consumers and starting ${up.includes('--watch') ? 'development' : 'production'}`, async () => {
      const environment = { FREE_SESSION_SECRET: 'test-only' }
      for (const existing of [false, true]) {
        const calls = []
        let serving = existing
        const status = await startComposeStack(up, environment, (command, args, options) => {
          assert.equal(command, 'docker')
          assert.equal(options.env, environment)
          assert.equal(options.shell, false)
          calls.push(args)
          if (args.includes('build')) assert.equal(serving, existing, 'build leaves the current deployment alone')
          if (args.includes('stop')) serving = false
          if (args.includes('up')) assert.equal(serving, false, 'migration cannot overlap the old schema consumers')
          const child = new EventEmitter()
          queueMicrotask(() => child.emit('exit', 0))
          return child
        })
        const prefix = up.slice(0, up.indexOf('up'))
        assert.equal(status, 0)
        assert.deepEqual(calls, [
          [...prefix, 'build'],
          [...prefix, 'stop', '--timeout', '60', 'studio', 'parsing_service', 'parsing_worker'],
          up,
        ])
      }
    })
  }

  it('stops after any failed command, preserving its exit status', async () => {
    for (const outcomes of [[12], [0, 17], [0, 0, 23]]) {
      let calls = 0
      const status = await startComposeStack(local, {}, () => {
        const child = new EventEmitter()
        const outcome = outcomes[calls++]
        assert.notEqual(outcome, undefined, 'no command may run after a failure')
        queueMicrotask(() => child.emit('exit', outcome))
        return child
      })
      assert.equal(calls, outcomes.length)
      assert.equal(status, outcomes.at(-1))
    }
  })

  it('does not stop services when the build process cannot start', async () => {
    let calls = 0
    await assert.rejects(startComposeStack(local, {}, () => {
      calls += 1
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', new Error('Docker could not start')))
      return child
    }), /Docker could not start/)
    assert.equal(calls, 1)
  })
})

describe('development launcher profiles', () => {
  it('keeps the default profile loopback-only behind the nginx entry point', () => {
    const profile = deriveDevProfile(parseDevOptions([]), interfaces)

    assert.equal(profile.origin, 'https://localhost:8443')
    assert.equal(profile.nginxBind, '127.0.0.1')
    assert.equal(profile.wifi, false)
    assert.equal(profile.entra, false)
    assert.deepEqual(developmentComposeFiles(profile), [
      'compose.yaml',
      'compose.override.yaml',
    ])
    assert.deepEqual(developmentComposeArguments(profile), [
      'compose',
      '--profile',
      'mock-oidc',
      '-f',
      'compose.yaml',
      '-f',
      'compose.override.yaml',
      'up',
      '--watch',
    ])
  })

  it('selects the canonical loopback real-Entra Compose profile', () => {
    const profile = deriveDevProfile(parseDevOptions(['--entra']), interfaces)

    assert.equal(profile.entra, true)
    assert.equal(profile.origin, 'https://localhost:8443')
    assert.equal(profile.nginxBind, '127.0.0.1')
    assert.deepEqual(developmentComposeFiles(profile), [
      'compose.yaml',
      'compose.override.yaml',
      'compose.entra.yaml',
    ])
    assert.deepEqual(developmentComposeArguments(profile), [
      'compose',
      '-f',
      'compose.yaml',
      '-f',
      'compose.override.yaml',
      '-f',
      'compose.entra.yaml',
      'up',
      '--watch',
    ])
  })

  it('selects Wi-Fi ahead of other private adapters', () => {
    assert.equal(selectWifiAddress(interfaces), '192.168.1.149')
    const profile = deriveDevProfile(parseDevOptions(['--wifi']), interfaces)

    assert.equal(profile.origin, 'https://192.168.1.149:8443')
    assert.equal(profile.nginxBind, '0.0.0.0')
  })

  it('accepts an explicit private host and managed firewall', () => {
    const profile = deriveDevProfile(
      parseDevOptions(['--host=10.0.0.8', '--firewall=off']),
      interfaces,
    )

    assert.equal(profile.origin, 'https://10.0.0.8:8443')
    assert.equal(profile.wifi, true)
    assert.equal(profile.firewall, false)
  })

  it('rejects network and firewall options with real Entra', () => {
    for (const argument of [
      '--wifi',
      '--host=10.0.0.8',
      '--firewall=on',
      '--firewall=off',
    ])
      assert.throws(
        () => parseDevOptions(['--entra', argument]),
        /--entra cannot be combined/,
      )
    assert.throws(
      () => parseDevOptions(['--entra', '--revoke-wifi-access']),
      /cannot be combined/,
    )
  })

  it('rejects a public explicit host', () => {
    assert.throws(
      () =>
        deriveDevProfile(
          parseDevOptions(['--host=203.0.113.8']),
          interfaces,
        ),
      /private IPv4/,
    )
  })

  it('rejects malformed private-looking hosts', () => {
    for (const host of [
      '10.example.invalid',
      '172.16.-1.4',
      '192.168.1.999',
      '10.20.30.',
    ]) {
      assert.throws(
        () => deriveDevProfile(parseDevOptions([`--host=${host}`]), interfaces),
        /private IPv4/,
      )
    }
  })

  it('isolates Compose development from deployment environment values', () => {
    const profile = deriveDevProfile(parseDevOptions([]), interfaces)
    const environment = developmentComposeEnvironment(
      profile,
      {
        PATH: 'kept',
        FREE_GPU: 'required',
        FREE_NGINX_PORT: '443',
        FREE_POSTGRES_PASSWORD: 'deployment-secret',
        STUDIO_BASE_PATH: '/deployment',
        STUDIO_ORIGIN: 'https://free.example.edu',
        FREE_SESSION_SECRET: 'ZGVwbG95bWVudC1zZWNyZXQtdGhhdC1pcy0zMi1ieXRlcyE=',
        FREE_NGINX_BIND: '0.0.0.0',
        FREE_MOCK_OIDC_BIND: '0.0.0.0',
        FREE_ENTRA_REAL: '1',
        FREE_ENTRA_TENANT_ID: '20000000-0000-4000-8000-000000000001',
        FREE_ENTRA_CLIENT_ID: '20000000-0000-4000-8000-000000000002',
        FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AA'.repeat(32),
        FREE_ENTRA_CLIENT_CERT_PATH: '/deployment/client.pem',
        COMPOSE_PROFILES: 'deployment-profile',
      },
      'ZGV2ZWxvcG1lbnQtc2VjcmV0LXRoYXQtaXMtMzItYnl0ZXMhIQ==',
    )

    assert.equal(environment.PATH, 'kept')
    assert.equal(environment.COMPOSE_DISABLE_ENV_FILE, '1')
    assert.equal(environment.FREE_GPU, 'required')
    assert.equal(environment.FREE_NGINX_PORT, '8443')
    assert.equal(environment.FREE_POSTGRES_PASSWORD, 'postgres')
    assert.equal(environment.STUDIO_BASE_PATH, '/free')
    assert.equal(environment.STUDIO_ORIGIN, 'https://localhost:8443')
    assert.equal(environment.FREE_NGINX_BIND, '127.0.0.1')
    assert.equal(environment.COMPOSE_PROFILES, undefined)
    assert.equal(environment.FREE_MOCK_OIDC_BIND, '127.0.0.1')
    assert.equal(environment.FREE_ENTRA_REAL, '0')
    assert.equal(environment.FREE_ENTRA_TENANT_ID, undefined)
    assert.equal(environment.FREE_ENTRA_CLIENT_ID, undefined)
    assert.equal(environment.FREE_ENTRA_CLIENT_CERT_THUMBPRINT, undefined)
    assert.equal(environment.FREE_ENTRA_CLIENT_CERT_PATH, undefined)
    assert.equal(
      environment.FREE_SESSION_SECRET,
      'ZGV2ZWxvcG1lbnQtc2VjcmV0LXRoYXQtaXMtMzItYnl0ZXMhIQ==',
    )
  })

  it('passes only validated credentials into the isolated real-Entra profile', () => {
    const certificatePath = temporaryFile('client.pem')
    const profile = deriveDevProfile(parseDevOptions(['--entra']), interfaces)
    const entraEnvironment = loadLocalEntraEnvironment(
      validEntraEnvironment(certificatePath),
      null,
    )
    const environment = developmentComposeEnvironment(
      profile,
      {
        PATH: 'kept',
        FREE_GPU: 'required',
        FREE_NGINX_PORT: '443',
        FREE_NGINX_BIND: '0.0.0.0',
        FREE_MOCK_OIDC_BIND: '0.0.0.0',
        FREE_ENTRA_REAL: '0',
        FREE_ENTRA_MOCK_ISSUER: 'https://fake.invalid',
        FREE_ENTRA_MOCK_BROWSER_ISSUER: 'https://fake.invalid',
        FREE_ENTRA_CLIENT_ID: 'deployment-client',
        FREE_POSTGRES_PASSWORD: 'deployment-secret',
        FREE_SESSION_SECRET: 'deployment-secret',
        STUDIO_BASE_PATH: '/deployment',
        STUDIO_ORIGIN: 'https://free.example.edu',
        COMPOSE_PROFILES: 'mock-oidc',
      },
      'ZGV2ZWxvcG1lbnQtc2VjcmV0LXRoYXQtaXMtMzItYnl0ZXMhIQ==',
      entraEnvironment,
    )

    assert.equal(environment.PATH, 'kept')
    assert.equal(environment.FREE_GPU, 'required')
    assert.equal(environment.FREE_NGINX_PORT, '8443')
    assert.equal(environment.FREE_NGINX_BIND, '127.0.0.1')
    assert.equal(environment.COMPOSE_PROFILES, undefined)
    assert.equal(environment.FREE_MOCK_OIDC_BIND, undefined)
    assert.equal(environment.FREE_POSTGRES_PASSWORD, 'postgres')
    assert.equal(
      environment.FREE_SESSION_SECRET,
      'ZGV2ZWxvcG1lbnQtc2VjcmV0LXRoYXQtaXMtMzItYnl0ZXMhIQ==',
    )
    assert.equal(environment.STUDIO_BASE_PATH, '/free')
    assert.equal(environment.STUDIO_ORIGIN, 'https://localhost:8443')
    assert.equal(environment.FREE_ENTRA_REAL, '1')
    assert.equal(environment.FREE_ENTRA_MOCK_ISSUER, undefined)
    assert.equal(environment.FREE_ENTRA_MOCK_BROWSER_ISSUER, undefined)
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(entraEnvironment).map((field) => [
          field,
          environment[field],
        ]),
      ),
      entraEnvironment,
    )
  })

  it('keeps one development session secret per machine', () => {
    const file = temporarySecretFile()

    const generated = ensureDevelopmentSessionSecret(file)

    assert.equal(Buffer.from(generated, 'base64').toString('base64'), generated)
    assert.ok(Buffer.from(generated, 'base64').byteLength >= 32)
    assert.equal(ensureDevelopmentSessionSecret(file), generated)
    assert.equal(readFileSync(file, 'utf8').trim(), generated)
  })

  it('replaces a development session secret the server would reject', () => {
    const file = temporarySecretFile()
    ensureDevelopmentSessionSecret(file)
    writeFileSync(file, 'not base64 at all')

    const replaced = ensureDevelopmentSessionSecret(file)

    assert.notEqual(replaced, 'not base64 at all')
    assert.ok(Buffer.from(replaced, 'base64').byteLength >= 32)
    assert.equal(ensureDevelopmentSessionSecret(file), replaced)
  })

  it(
    'keeps a development session secret private on POSIX',
    { skip: process.platform === 'win32' },
    () => {
      const file = temporarySecretFile()
      ensureDevelopmentSessionSecret(file)
      chmodSync(file, 0o644)

      ensureDevelopmentSessionSecret(file)

      assert.equal(statSync(file).mode & 0o777, 0o600)
    },
  )

  it('rejects unknown options', () => {
    assert.throws(
      () => parseDevOptions(['--anything']),
      /Unknown development option/,
    )
  })

  it('keeps firewall revocation an exclusive command', () => {
    assert.equal(
      parseDevOptions(['--revoke-wifi-access']).revokeWifiAccess,
      true,
    )
    assert.throws(
      () => parseDevOptions(['--revoke-wifi-access', '--wifi']),
      /cannot be combined/,
    )
  })
})

describe('local real-Entra configuration', () => {
  it('loads .env values with the process environment taking precedence', () => {
    const certificatePath = temporaryFile('client.pem')
    const dotEnvironment = validEntraEnvironment(certificatePath)
    const environment = {
      FREE_ENTRA_CLIENT_ID: 'A0000000-0000-4000-8000-00000000000A',
      UNSET_VALUE: undefined,
    }

    const effective = effectiveLocalEnvironment(environment, dotEnvironment)
    const loaded = loadLocalEntraEnvironment(
      environment,
      dotEnvironment,
      () => true,
    )

    assert.equal(
      effective.FREE_ENTRA_TENANT_ID,
      dotEnvironment.FREE_ENTRA_TENANT_ID,
    )
    assert.equal(effective.FREE_ENTRA_CLIENT_ID, environment.FREE_ENTRA_CLIENT_ID)
    assert.equal(effective.UNSET_VALUE, undefined)
    assert.deepEqual(loaded, {
      FREE_ENTRA_TENANT_ID: dotEnvironment.FREE_ENTRA_TENANT_ID,
      FREE_ENTRA_CLIENT_ID: 'a0000000-0000-4000-8000-00000000000a',
      FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AB'.repeat(32),
      FREE_ENTRA_CLIENT_CERT_PATH: certificatePath,
    })
  })

  it('reports every missing Entra value together', () => {
    const errors = validateLocalEntraEnvironment({}, () => true)

    for (const field of [
      'FREE_ENTRA_TENANT_ID',
      'FREE_ENTRA_CLIENT_ID',
      'FREE_ENTRA_CLIENT_CERT_THUMBPRINT',
      'FREE_ENTRA_CLIENT_CERT_PATH',
    ])
      assert.ok(errors.some((error) => error.includes(`${field} is required`)))
    assert.throws(
      () => loadLocalEntraEnvironment({}, null, () => true),
      /FREE_ENTRA_TENANT_ID[\s\S]*FREE_ENTRA_CLIENT_CERT_PATH/,
    )
  })

  it('uses Studio configuration validation for UUIDs and thumbprints', () => {
    const errors = validateLocalEntraEnvironment(
      {
        ...validEntraEnvironment('client.pem'),
        FREE_ENTRA_TENANT_ID: '10000000-0000-0000-0000-000000000001',
        FREE_ENTRA_CLIENT_ID: 'not-a-uuid',
        FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AA:BB',
      },
      () => true,
    )

    assert.deepEqual(errors, [
      'FREE_ENTRA_TENANT_ID must be a UUID.',
      'FREE_ENTRA_CLIENT_ID must be a UUID.',
      'FREE_ENTRA_CLIENT_CERT_THUMBPRINT must be the SHA-256 certificate thumbprint (64 hex digits, colons allowed).',
    ])
  })

  it('requires the selected client certificate to exist on the host', () => {
    assert.deepEqual(
      validateLocalEntraEnvironment(
        validEntraEnvironment('missing-client.pem'),
        () => false,
      ),
      [
        'FREE_ENTRA_CLIENT_CERT_PATH names missing-client.pem, which does not exist on this host.',
      ],
    )
  })

  it('cannot apply credentials to the wrong identity profile', () => {
    const mockProfile = deriveDevProfile(parseDevOptions([]), interfaces)
    const entraProfile = deriveDevProfile(
      parseDevOptions(['--entra']),
      interfaces,
    )
    const entraEnvironment = validEntraEnvironment('client.pem')

    assert.throws(
      () =>
        developmentComposeEnvironment(
          mockProfile,
          {},
          'development-secret',
          entraEnvironment,
        ),
      /cannot be applied to the mock OIDC profile/,
    )
    assert.throws(
      () =>
        developmentComposeEnvironment(
          entraProfile,
          {},
          'development-secret',
        ),
      /requires validated Entra configuration/,
    )
  })
})

describe('Compose version preflight', () => {
  it('accepts the minimum and newer Compose versions', () => {
    assert.doesNotThrow(() => validateComposeVersion('2.40.0'))
    assert.doesNotThrow(() => validateComposeVersion('v5.4.0'))
    assert.doesNotThrow(() =>
      validateComposeVersion('Docker Compose version v2.40.0-desktop.1'),
    )
  })

  it('rejects older and unrecognizable Compose versions', () => {
    assert.throws(
      () => validateComposeVersion('2.33.1'),
      /2\.40\.0.*found 2\.33\.1/,
    )
    assert.throws(
      () => validateComposeVersion('unknown'),
      /could not be determined/,
    )
  })
})

describe('Docker build context', () => {
  it('excludes per-machine development secrets', () => {
    const dockerignore = readFileSync(
      new URL('../.dockerignore', import.meta.url),
      'utf8',
    )
    assert.match(dockerignore, /^\.dev$/m)
  })
})

const productionEnvironment = {
  STUDIO_ORIGIN: 'https://free.example.edu',
  STUDIO_BASE_PATH: '/free',
  FREE_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'),
  FREE_POSTGRES_PASSWORD: 'a'.repeat(64),
  FREE_PARSING_POSTGRES_PASSWORD: 'c'.repeat(64),
  FREE_KEI_POSTGRES_PASSWORD: 'd'.repeat(64),
  FREE_ENTRA_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  FREE_ENTRA_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AB'.repeat(32),
  FREE_ENTRA_CLIENT_CERT_PATH: '/srv/free-secrets/entra-client.pem',
}

describe('production environment validation', () => {
  it('accepts a complete, well-formed deployment environment', () => {
    assert.deepEqual(
      validateProductionEnvironment(productionEnvironment, () => true),
      [],
    )
  })

  it('reports every missing value at once', () => {
    const errors = validateProductionEnvironment({}, () => true)
    for (const name of [
      ...SHARED_STUDIO_CONFIGURATION_FIELDS,
      'FREE_POSTGRES_PASSWORD',
      'FREE_PARSING_POSTGRES_PASSWORD',
      'FREE_KEI_POSTGRES_PASSWORD',
    ])
      assert.ok(
        errors.some((error) => error.includes(`${name} is required`)),
        `expected an error for ${name}`,
      )
  })

  it('rejects an origin carrying a path and a root base path', () => {
    const errors = validateProductionEnvironment(
      {
        ...productionEnvironment,
        STUDIO_ORIGIN: 'https://free.example.edu/free',
        STUDIO_BASE_PATH: '/',
      },
      () => true,
    )
    assert.ok(errors.some((error) => error.includes('STUDIO_ORIGIN')))
    assert.ok(errors.some((error) => error.includes('STUDIO_BASE_PATH')))
  })

  it('rejects an HTTP origin', () => {
    const errors = validateProductionEnvironment(
      { ...productionEnvironment, STUDIO_ORIGIN: 'http://free.example.edu' },
      () => true,
    )
    assert.ok(errors.some((error) => error.includes('STUDIO_ORIGIN')))
  })

  it('rejects a short or non-canonical session secret', () => {
    for (const secret of [
      Buffer.alloc(16).toString('base64'),
      'not base64!!',
    ]) {
      const errors = validateProductionEnvironment(
        { ...productionEnvironment, FREE_SESSION_SECRET: secret },
        () => true,
      )
      assert.ok(errors.some((error) => error.includes('FREE_SESSION_SECRET')))
    }
  })

  it('adapts the shared syntax issues instead of redefining their rules', () => {
    for (const override of [
      { STUDIO_ORIGIN: 'https://free.example.edu/path' },
      { STUDIO_BASE_PATH: '/free/' },
      { FREE_SESSION_SECRET: 'not base64!!' },
      { FREE_ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000001' },
      { FREE_ENTRA_CLIENT_ID: 'not-a-uuid' },
      { FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AB' },
    ]) {
      const environment = { ...productionEnvironment, ...override }
      const shared = validateSharedStudioConfiguration(environment)
      assert.equal(shared.issues.length, 1)
      assert.ok(
        validateProductionEnvironment(environment, () => true).some((error) =>
          error.includes(shared.issues[0].field),
        ),
        `launcher did not adapt the shared ${shared.issues[0].field} issue`,
      )
    }
  })

  it('rejects weak or URL-unsafe passwords for every database role', () => {
    for (const field of ['FREE_POSTGRES_PASSWORD', 'FREE_PARSING_POSTGRES_PASSWORD', 'FREE_KEI_POSTGRES_PASSWORD']) {
      const errors = validateProductionEnvironment(
        { ...productionEnvironment, [field]: 'p@ss word' },
        () => true,
      )
      assert.ok(errors.some((error) => error.includes(field)))
    }
  })

  it('accepts a colon-separated thumbprint and rejects a truncated one', () => {
    const colons = 'AB:'.repeat(31) + 'AB'
    assert.deepEqual(
      validateProductionEnvironment(
        { ...productionEnvironment, FREE_ENTRA_CLIENT_CERT_THUMBPRINT: colons },
        () => true,
      ),
      [],
    )
    const errors = validateProductionEnvironment(
      { ...productionEnvironment, FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AB' },
      () => true,
    )
    assert.ok(
      errors.some((error) =>
        error.includes('FREE_ENTRA_CLIENT_CERT_THUMBPRINT'),
      ),
    )
  })

  it('requires the Entra client certificate file to exist', () => {
    const errors = validateProductionEnvironment(
      productionEnvironment,
      (path) => path !== productionEnvironment.FREE_ENTRA_CLIENT_CERT_PATH,
    )
    assert.ok(
      errors.some((error) => error.includes('FREE_ENTRA_CLIENT_CERT_PATH')),
    )
  })
})

describe('production TLS entry point', () => {
  const containerEnvironment = {
    ...productionEnvironment,
    FREE_NGINX: 'container',
    FREE_TLS_CERT_PATH: '/srv/free-tls/studio.crt',
    FREE_TLS_KEY_PATH: '/srv/free-tls/studio.key',
  }

  it('defaults to the host nginx with the plain production overlay', () => {
    assert.deepEqual(productionComposeFiles(productionEnvironment), [
      'compose.yaml',
      'compose.prod.yaml',
    ])
  })

  it('adds the bundled nginx overlay when TLS terminates in a container', () => {
    assert.deepEqual(
      validateProductionEnvironment(containerEnvironment, () => true),
      [],
    )
    assert.deepEqual(productionComposeFiles(containerEnvironment), [
      'compose.yaml',
      'compose.prod.yaml',
      'compose.nginx.yaml',
    ])
  })

  it('requires both TLS files to exist on the host for the container', () => {
    for (const field of ['FREE_TLS_CERT_PATH', 'FREE_TLS_KEY_PATH']) {
      const missing = validateProductionEnvironment(
        { ...containerEnvironment, [field]: undefined },
        () => true,
      )
      assert.ok(missing.some((error) => error.includes(`${field} is required`)))
      const absent = validateProductionEnvironment(
        containerEnvironment,
        (path) => path !== containerEnvironment[field],
      )
      assert.ok(absent.some((error) => error.includes(`${field} names`)))
    }
  })

  it('rejects an unknown TLS entry point', () => {
    const errors = validateProductionEnvironment(
      { ...productionEnvironment, FREE_NGINX: 'traefik' },
      () => true,
    )
    assert.ok(errors.some((error) => error.includes('FREE_NGINX')))
  })
})

describe('shared nginx behavior rendering', () => {
  it('substitutes exactly the two shared template variables', () => {
    const rendered = renderNginxLocations(
      'location ^~ ${STUDIO_BASE_PATH}/ { proxy_pass http://${FREE_STUDIO_UPSTREAM}; proxy_set_header Host $http_host; }',
      { STUDIO_BASE_PATH: '/free', FREE_STUDIO_UPSTREAM: '127.0.0.1:5173' },
    )
    assert.equal(
      rendered,
      'location ^~ /free/ { proxy_pass http://127.0.0.1:5173; proxy_set_header Host $http_host; }',
    )
  })

  it('leaves nginx runtime variables untouched', () => {
    assert.equal(
      renderNginxLocations('proxy_set_header X-Real-IP $remote_addr;', {}),
      'proxy_set_header X-Real-IP $remote_addr;',
    )
  })
})
