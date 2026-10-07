import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { Readable } from 'node:stream'
import { canonicalStudioBasePath } from 'studio-configuration'
import { applyStudioBaseTag } from '../shared/studioBasePath.js'
import type { ClientHandler } from './app.js'
import { APP_SHELL_CONTENT_SECURITY_POLICY } from './contentSecurityPolicy.js'

const MIME_TYPE: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
const PUBLIC_FILES: Readonly<Record<string, true>> = {
  '/favicon.png': true,
  '/free-logo.png': true,
  '/--free-logo.png': true,
}
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/
const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'no-cache'

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

function staticRequestPath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const segments = decoded.split('/').slice(1)
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  )
    return null
  return segments.join('/')
}

function fileResponse(
  absolutePath: string,
  size: number,
  request: Request,
  cacheControl: string,
): Response {
  const headers = new Headers({
    'Cache-Control': cacheControl,
    'Content-Length': String(size),
    'Content-Type':
      MIME_TYPE[extname(absolutePath).toLowerCase()] ??
      'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  })
  if (request.method === 'HEAD') return new Response(null, { headers })
  return new Response(
    Readable.toWeb(createReadStream(absolutePath)) as unknown as RequestInit['body'],
    { headers },
  )
}

async function indexResponse(
  absolutePath: string,
  request: Request,
  basePath: string,
): Promise<Response> {
  const source = await readFile(absolutePath, 'utf8')
  const body = Buffer.from(applyStudioBaseTag(source, basePath))
  const headers = new Headers({
    'Cache-Control': REVALIDATE,
    'Content-Length': String(body.byteLength),
    'Content-Security-Policy': APP_SHELL_CONTENT_SECURITY_POLICY,
    'Content-Type': MIME_TYPE['.html'],
    'X-Content-Type-Options': 'nosniff',
  })
  return request.method === 'HEAD'
    ? new Response(null, { headers })
    : new Response(body, { headers })
}

export function createStaticClientHandler(
  clientRoot: string,
  configuredBasePath: string,
): ClientHandler {
  const root = resolve(clientRoot)
  const basePath = canonicalStudioBasePath(configuredBasePath)
  return async function staticClient(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound()
    const pathname = new URL(request.url).pathname
    const servesFile = pathname.startsWith('/assets/') || PUBLIC_FILES[pathname]
    const relativeFile = servesFile ? staticRequestPath(pathname) : 'index.html'
    if (!relativeFile) return notFound()

    const absolutePath = resolve(join(root, relativeFile))
    const fromRoot = relative(root, absolutePath)
    if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot))
      return notFound()

    let fileSize: number
    try {
      const descriptor = await stat(absolutePath)
      if (!descriptor.isFile()) return notFound()
      fileSize = descriptor.size
    } catch {
      return notFound()
    }

    if (relativeFile === 'index.html')
      return indexResponse(absolutePath, request, basePath)

    const immutable =
      pathname.startsWith('/assets/') && HASHED_ASSET.test(relativeFile)
    return fileResponse(
      absolutePath,
      fileSize,
      request,
      immutable ? IMMUTABLE : REVALIDATE,
    )
  }
}
