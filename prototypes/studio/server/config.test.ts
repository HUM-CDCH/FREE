import { describe, expect, it } from 'vitest'
import {
  createClientAddressResolver,
  createRequestPeerVerifier,
  loadStudioServerConfig,
  type ClientAddressBindings,
} from './config.js'

const SECRET = Buffer.alloc(32, 11).toString('base64')
const HOSTED = {
  STUDIO_ORIGIN: 'https://studio.example',
  STUDIO_BASE_PATH: '/free',
  FREE_SESSION_SECRET: SECRET,
  FREE_STUDIO_PROXY: 'trusted-proxy',
  FREE_STUDIO_PROXY_ADDRESS: '172.30.0.2',
} satisfies NodeJS.ProcessEnv

function requestBindings(
  peer: string,
  clientAddress?: string | string[],
): ClientAddressBindings {
  return {
    incoming: {
      headers:
        clientAddress === undefined
          ? {}
          : { 'x-free-client-address': clientAddress },
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
          STUDIO_ORIGIN: 'http://127.0.0.1:5173',
          STUDIO_BASE_PATH: '/',
          FREE_SESSION_SECRET: SECRET,
          FREE_STUDIO_PROXY: 'loopback',
          PORT: port,
        }),
      ).toThrow(/PORT/)
    expect(() =>
      loadStudioServerConfig({
        STUDIO_ORIGIN: 'http://studio.example:5173',
        STUDIO_BASE_PATH: '/',
        FREE_SESSION_SECRET: SECRET,
        FREE_STUDIO_PROXY: 'loopback',
      }),
    ).toThrow(/Loopback STUDIO_ORIGIN/)
    expect(() =>
      loadStudioServerConfig({
        STUDIO_ORIGIN: 'http://127.0.0.1:5173',
        STUDIO_BASE_PATH: '/',
        FREE_SESSION_SECRET: SECRET,
        FREE_STUDIO_PROXY: 'loopback',
        FREE_STUDIO_PROXY_ADDRESS: '127.0.0.1',
      }),
    ).toThrow(/must be omitted/)
  })

  it('allows an explicit container loopback exception', () => {
    const config = loadStudioServerConfig({
      STUDIO_ORIGIN: 'http://localhost:5173',
      STUDIO_BASE_PATH: '/',
      FREE_SESSION_SECRET: SECRET,
      FREE_STUDIO_PROXY: 'container-loopback',
    })
    expect(config).toMatchObject({
      proxyMode: 'container-loopback',
      proxyAddress: null,
      hostname: '0.0.0.0',
    })

    const bindings = requestBindings('172.18.0.1', '203.0.113.99')
    expect(() => createRequestPeerVerifier(config)(bindings)).not.toThrow()
    expect(createClientAddressResolver(config)(bindings)).toBe('172.18.0.1')
  })
})

describe('trusted request peer and client address', () => {
  it('rejects direct or spoofed hosted peers before consuming the header', () => {
    const config = loadStudioServerConfig(HOSTED)
    const verifyPeer = createRequestPeerVerifier(config)
    const clientAddress = createClientAddressResolver(config)
    const proxy = requestBindings('::ffff:172.30.0.2', '198.51.100.7')

    expect(() => verifyPeer(proxy)).not.toThrow()
    expect(clientAddress(proxy)).toBe('198.51.100.7')

    const spoofed = requestBindings('172.30.0.9', '198.51.100.7')
    expect(() => verifyPeer(spoofed)).toThrowError(
      expect.objectContaining({ status: 403, code: 'proxy_peer_rejected' }),
    )
    expect(() => clientAddress(spoofed)).toThrowError(
      expect.objectContaining({ status: 403, code: 'proxy_peer_rejected' }),
    )
  })

  it('requires one valid proxy-overwritten client address', () => {
    const resolver = createClientAddressResolver(loadStudioServerConfig(HOSTED))
    for (const bindings of [
      requestBindings('172.30.0.2'),
      requestBindings('172.30.0.2', ['198.51.100.7', '198.51.100.8']),
      requestBindings('172.30.0.2', 'not-an-ip'),
    ])
      expect(() => resolver(bindings)).toThrowError(
        expect.objectContaining({
          status: 400,
          code: 'proxy_contract_required',
        }),
      )
  })

  it('uses the loopback socket and ignores a browser-supplied header', () => {
    const config = loadStudioServerConfig({
      STUDIO_ORIGIN: 'http://localhost:5173',
      STUDIO_BASE_PATH: '/',
      FREE_SESSION_SECRET: SECRET,
      FREE_STUDIO_PROXY: 'loopback',
    })
    const bindings = requestBindings('::ffff:127.0.0.1', '203.0.113.99')
    expect(() => createRequestPeerVerifier(config)(bindings)).not.toThrow()
    expect(createClientAddressResolver(config)(bindings)).toBe('127.0.0.1')
  })
})
