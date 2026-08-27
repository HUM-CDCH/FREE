import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { ApiError } from '../api/_http.js'
import { canonicalStudioBasePath } from '../shared/studioBasePath.js'
import { normalizeCanonicalUuid } from '../shared/uuid.js'
import { canonicalStudioOrigin } from './origin.js'
import { normalizeClientAddress } from './request-address.js'

export const STUDIO_PORT = 5173

export type StudioProxyMode = 'trusted-proxy' | 'loopback'
export type StudioServerConfig = {
  studioOrigin: string
  basePath: string
  sessionSecret: Buffer
  entra: {
    tenantId: string
    clientId: string
    certificatePath: string
    certificateThumbprint: string
  }
  proxyMode: StudioProxyMode
  proxyAddress: string | null
  hostname: '0.0.0.0' | '127.0.0.1'
  port: number
}

export type ClientAddressBindings = {
  incoming?: Pick<IncomingMessage, 'socket'>
}
export class StudioConfigurationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StudioConfigurationError'
  }
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]
  if (value === undefined || value === '')
    throw new StudioConfigurationError(`${name} is required.`)
  return value
}

function sessionSecret(value: string): Buffer {
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch (cause) {
    throw new StudioConfigurationError(
      'FREE_SESSION_SECRET must be canonical base64.',
      { cause },
    )
  }
  if (decoded.toString('base64') !== value)
    throw new StudioConfigurationError(
      'FREE_SESSION_SECRET must be canonical base64.',
    )
  if (decoded.byteLength < 32)
    throw new StudioConfigurationError(
      'FREE_SESSION_SECRET must decode to at least 32 bytes.',
    )
  return decoded
}

function uuid(value: string, name: string): string {
  const normalized = normalizeCanonicalUuid(value)
  if (normalized === null)
    throw new StudioConfigurationError(`${name} must be a UUID.`)
  return normalized
}

export function normalizeEntraCertificateThumbprint(value: string): string {
  const normalized = value.replaceAll(':', '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(normalized))
    throw new StudioConfigurationError(
      'FREE_ENTRA_CLIENT_CERT_THUMBPRINT must be a SHA-256 certificate thumbprint.',
    )
  return normalized
}

function studioOrigin(value: string, proxyMode: StudioProxyMode): string {
  let origin: string
  try {
    origin = canonicalStudioOrigin(value)
  } catch (cause) {
    throw new StudioConfigurationError(
      'STUDIO_ORIGIN must be a canonical HTTP or HTTPS origin.',
      { cause },
    )
  }

  const parsed = new URL(origin)
  if (proxyMode === 'trusted-proxy') {
    if (parsed.protocol !== 'https:')
      throw new StudioConfigurationError(
        'Hosted STUDIO_ORIGIN must use HTTPS.',
      )
    return origin
  }

  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1' &&
    hostname !== '[::1]'
  )
    throw new StudioConfigurationError(
      'Loopback STUDIO_ORIGIN must name localhost, 127.0.0.1, or [::1].',
    )
  return origin
}

function canonicalProxyAddress(value: string): string {
  const family = isIP(value)
  let canonical = value
  if (family === 6) {
    try {
      canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
    } catch {
      canonical = ''
    }
  }
  if (family === 0 || canonical !== value)
    throw new StudioConfigurationError(
      'FREE_STUDIO_PROXY_ADDRESS must be one canonical IP address.',
    )
  return value
}

function studioBasePath(value: string): string {
  try {
    return canonicalStudioBasePath(value)
  } catch (cause) {
    throw new StudioConfigurationError(
      'STUDIO_BASE_PATH must be / or one canonical absolute path without a trailing slash.',
      { cause },
    )
  }
}

function studioPort(
  environment: NodeJS.ProcessEnv,
  proxyMode: StudioProxyMode,
): number {
  const supplied = environment.PORT
  if (supplied === undefined) return STUDIO_PORT
  if (!/^[1-9]\d{0,4}$/.test(supplied) || Number(supplied) > 65_535)
    throw new StudioConfigurationError(
      'PORT must be an integer from 1 through 65535.',
    )
  const port = Number(supplied)
  if (proxyMode === 'trusted-proxy' && port !== STUDIO_PORT)
    throw new StudioConfigurationError(
      `Hosted Studio must listen on port ${STUDIO_PORT}.`,
    )
  return port
}

export function loadStudioServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): StudioServerConfig {
  const proxy = required(environment, 'FREE_STUDIO_PROXY')
  if (
    proxy !== 'trusted-proxy' &&
    proxy !== 'loopback'
  )
    throw new StudioConfigurationError(
      'FREE_STUDIO_PROXY must be trusted-proxy or loopback.',
    )
  const proxyMode: StudioProxyMode = proxy
  let proxyAddress: string | null = null
  if (proxyMode === 'trusted-proxy')
    proxyAddress = canonicalProxyAddress(
      required(environment, 'FREE_STUDIO_PROXY_ADDRESS'),
    )
  else if (environment.FREE_STUDIO_PROXY_ADDRESS !== undefined)
    throw new StudioConfigurationError(
      'FREE_STUDIO_PROXY_ADDRESS must be omitted in loopback mode.',
    )

  return {
    studioOrigin: studioOrigin(
      required(environment, 'STUDIO_ORIGIN'),
      proxyMode,
    ),
    basePath: studioBasePath(required(environment, 'STUDIO_BASE_PATH')),
    sessionSecret: sessionSecret(
      required(environment, 'FREE_SESSION_SECRET'),
    ),
    entra: {
      tenantId: uuid(
        required(environment, 'FREE_ENTRA_TENANT_ID'),
        'FREE_ENTRA_TENANT_ID',
      ),
      clientId: uuid(
        required(environment, 'FREE_ENTRA_CLIENT_ID'),
        'FREE_ENTRA_CLIENT_ID',
      ),
      certificatePath: required(
        environment,
        'FREE_ENTRA_CLIENT_CERT_PATH',
      ),
      certificateThumbprint: normalizeEntraCertificateThumbprint(
        required(environment, 'FREE_ENTRA_CLIENT_CERT_THUMBPRINT'),
      ),
    },
    proxyMode,
    proxyAddress,
    hostname: proxyMode === 'loopback' ? '127.0.0.1' : '0.0.0.0',
    port: studioPort(environment, proxyMode),
  }
}

export function createRequestPeerVerifier(config: StudioServerConfig) {
  if (config.proxyMode !== 'trusted-proxy') return (): void => {}

  const expected = config.proxyAddress!
  return (bindings: ClientAddressBindings): void => {
    const peer = normalizeClientAddress(
      bindings.incoming?.socket.remoteAddress,
    )
    if (peer !== expected)
      throw new ApiError(
        403,
        'proxy_peer_rejected',
        'The request did not arrive through the trusted Studio proxy.',
      )
  }
}
