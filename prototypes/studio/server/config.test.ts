import { describe, expect, it } from 'vitest'
import {
  createRequestPeerVerifier,
  loadStudioServerConfig,
  type ClientAddressBindings,
} from './config.js'

const SECRET = Buffer.alloc(32, 11).toString('base64')
const ENTRA = {
  FREE_ENTRA_TENANT_ID: '10000000-0000-4000-8000-000000000001',
  FREE_ENTRA_CLIENT_ID: '10000000-0000-4000-8000-000000000002',
  FREE_ENTRA_CLIENT_CERT_PATH: '/run/secrets/free-entra-client.pem',
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'ab:'.repeat(31) + 'ab',
} satisfies NodeJS.ProcessEnv
const HOSTED = {
  ...ENTRA,
  STUDIO_ORIGIN: 'https://studio.example',
  STUDIO_BASE_PATH: '/free',
  FREE_SESSION_SECRET: SECRET,
  FREE_STUDIO_PROXY: 'trusted-proxy',
  FREE_STUDIO_PROXY_ADDRESS: '172.30.0.2',
} satisfies NodeJS.ProcessEnv

function requestBindings(peer: string): ClientAddressBindings {
  return {
    incoming: {
      headers: {},
      socket: { remoteAddress: peer },
    },
  } as unknown as ClientAddressBindings
}

describe('production Studio configuration', () => {
  it('accepts only a complete hosted HTTPS and pinned-proxy contract', () => {
    expect(loadStudioServerConfig(HOSTED)).toEqual({
      studioOrigin: 'https://studio.example',
      basePath: '/free',
      sessionSecret: Buffer.alloc(32, 11),
      entra: {
        tenantId: ENTRA.FREE_ENTRA_TENANT_ID,
        clientId: ENTRA.FREE_ENTRA_CLIENT_ID,
        certificatePath: ENTRA.FREE_ENTRA_CLIENT_CERT_PATH,
        certificateThumbprint: 'AB'.repeat(32),
      },
      proxyMode: 'trusted-proxy',
      proxyAddress: '172.30.0.2',
      hostname: '0.0.0.0',
      port: 5173,
    })

    for (const name of [
      'STUDIO_ORIGIN',
      'STUDIO_BASE_PATH',
      'FREE_SESSION_SECRET',
      'FREE_STUDIO_PROXY',
      'FREE_STUDIO_PROXY_ADDRESS',
      'FREE_ENTRA_TENANT_ID',
      'FREE_ENTRA_CLIENT_ID',
      'FREE_ENTRA_CLIENT_CERT_PATH',
      'FREE_ENTRA_CLIENT_CERT_THUMBPRINT',
    ]) {
      const environment = { ...HOSTED }
      delete environment[name as keyof typeof environment]
      expect(() => loadStudioServerConfig(environment)).toThrow(name)
    }
  })

  it('requires one canonical deployment base path', () => {
    for (const basePath of ['', 'free', '/free/', '//free', '/free?x=1'])
      expect(() =>
        loadStudioServerConfig({ ...HOSTED, STUDIO_BASE_PATH: basePath }),
      ).toThrow(/STUDIO_BASE_PATH/)
  })

  it('does not couple the hosted mode to a proxy implementation', () => {
    for (const proxy of ['trusted-caddy', 'trusted-nginx', 'nginx'])
      expect(() =>
        loadStudioServerConfig({ ...HOSTED, FREE_STUDIO_PROXY: proxy }),
      ).toThrow(/FREE_STUDIO_PROXY/)
  })

  it('rejects noncanonical or insecure hosted origins', () => {
    for (const origin of [
      'http://studio.example',
      'https://studio.example/',
      'https://STUDIO.example',
      'https://studio.example:443',
      'https://studio.example/path',
      ' https://studio.example',
    ])
      expect(() =>
        loadStudioServerConfig({ ...HOSTED, STUDIO_ORIGIN: origin }),
      ).toThrow(/STUDIO_ORIGIN|HTTPS/)
  })

  it('rejects malformed, noncanonical, and undersized secrets', () => {
    for (const secret of [
      Buffer.alloc(31).toString('base64'),
      Buffer.alloc(32).toString('base64url'),
      `${SECRET}\n`,
      SECRET.replace(/=+$/, ''),
      'not base64',
    ])
      expect(() =>
        loadStudioServerConfig({ ...HOSTED, FREE_SESSION_SECRET: secret }),
      ).toThrow(/FREE_SESSION_SECRET/)
  })

  it('rejects malformed Entra identifiers and certificate thumbprints', () => {
    expect(() =>
      loadStudioServerConfig({
        ...HOSTED,
        FREE_ENTRA_TENANT_ID: 'common',
      }),
    ).toThrow(/FREE_ENTRA_TENANT_ID/)
    expect(() =>
      loadStudioServerConfig({
        ...HOSTED,
        FREE_ENTRA_CLIENT_ID: 'not-a-uuid',
      }),
    ).toThrow(/FREE_ENTRA_CLIENT_ID/)
    expect(() =>
      loadStudioServerConfig({
        ...HOSTED,
        FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'AA:BB',
      }),
    ).toThrow(/FREE_ENTRA_CLIENT_CERT_THUMBPRINT/)
  })

  it('requires one canonical proxy peer address', () => {
    for (const address of [
      '172.030.0.2',
      '172.30.0.2:443',
      ' 172.30.0.2',
      '2001:0db8:0:0:0:0:0:1',
      'not-an-ip',
    ])
      expect(() =>
        loadStudioServerConfig({
          ...HOSTED,
          FREE_STUDIO_PROXY_ADDRESS: address,
        }),
      ).toThrow(/FREE_STUDIO_PROXY_ADDRESS/)

    expect(
      loadStudioServerConfig({
        ...HOSTED,
        FREE_STUDIO_PROXY_ADDRESS: '2001:db8::1',
      }).proxyAddress,
    ).toBe('2001:db8::1')
  })

  it('allows only an explicit socket-only loopback exception', () => {
    const config = loadStudioServerConfig({
      ...ENTRA,
      STUDIO_ORIGIN: 'http://127.0.0.1:5173',
      STUDIO_BASE_PATH: '/',
      FREE_SESSION_SECRET: SECRET,
      FREE_STUDIO_PROXY: 'loopback',
    })
    expect(config).toMatchObject({
      proxyMode: 'loopback',
      proxyAddress: null,
      hostname: '127.0.0.1',
    })
    expect(
      loadStudioServerConfig({
        ...ENTRA,
        STUDIO_ORIGIN: 'http://127.0.0.1:5174',
        STUDIO_BASE_PATH: '/',
        FREE_SESSION_SECRET: SECRET,
        FREE_STUDIO_PROXY: 'loopback',
        PORT: '5174',
      }).port,
    ).toBe(5174)
    expect(() =>
      loadStudioServerConfig({ ...HOSTED, PORT: '5174' }),
    ).toThrow(/Hosted Studio must listen on port 5173/)
    for (const port of ['0', '65536', '5173.5', ' 5174'])
      expect(() =>
        loadStudioServerConfig({
          ...ENTRA,
          STUDIO_ORIGIN: 'http://127.0.0.1:5173',
          STUDIO_BASE_PATH: '/',
          FREE_SESSION_SECRET: SECRET,
          FREE_STUDIO_PROXY: 'loopback',
          PORT: port,
        }),
      ).toThrow(/PORT/)
    expect(() =>
      loadStudioServerConfig({
        ...ENTRA,
        STUDIO_ORIGIN: 'http://studio.example:5173',
        STUDIO_BASE_PATH: '/',
        FREE_SESSION_SECRET: SECRET,
        FREE_STUDIO_PROXY: 'loopback',
      }),
    ).toThrow(/Loopback STUDIO_ORIGIN/)
    expect(() =>
      loadStudioServerConfig({
        ...ENTRA,
        STUDIO_ORIGIN: 'http://127.0.0.1:5173',
        STUDIO_BASE_PATH: '/',
        FREE_SESSION_SECRET: SECRET,
        FREE_STUDIO_PROXY: 'loopback',
        FREE_STUDIO_PROXY_ADDRESS: '127.0.0.1',
      }),
    ).toThrow(/must be omitted/)
  })

  it('rejects the removed unverified container-loopback mode', () => {
    expect(() =>
      loadStudioServerConfig({
        ...ENTRA,
        STUDIO_ORIGIN: 'http://localhost:5173',
        STUDIO_BASE_PATH: '/',
        FREE_SESSION_SECRET: SECRET,
        FREE_STUDIO_PROXY: 'container-loopback',
      }),
    ).toThrow(/FREE_STUDIO_PROXY/)
  })
})

describe('trusted request peer', () => {
  it('rejects direct or spoofed hosted peers', () => {
    const verifyPeer = createRequestPeerVerifier(loadStudioServerConfig(HOSTED))

    expect(() =>
      verifyPeer(requestBindings('::ffff:172.30.0.2')),
    ).not.toThrow()
    expect(() =>
      verifyPeer(requestBindings('172.30.0.9')),
    ).toThrowError(
      expect.objectContaining({ status: 403, code: 'proxy_peer_rejected' }),
    )
  })


  it('accepts the loopback socket', () => {
    const config = loadStudioServerConfig({
      ...ENTRA,
      STUDIO_ORIGIN: 'http://localhost:5173',
      STUDIO_BASE_PATH: '/',
      FREE_SESSION_SECRET: SECRET,
      FREE_STUDIO_PROXY: 'loopback',
    })
    expect(() =>
      createRequestPeerVerifier(config)(requestBindings('::ffff:127.0.0.1')),
    ).not.toThrow()
  })
})
