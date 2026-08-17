import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ApiError, apiErrorResponse } from './api/_http.js'

// The leading [a-z] keeps `_`-prefixed private modules such as /api/_model_config
// unreachable; handlers themselves declare which methods they export.
const API_ROUTE = /^\/api\/([a-z][a-z_]*)$/
const SOURCE_DOCUMENT_INGESTION_ROUTE =
  /^\/api\/project-contexts\/[^/]+\/source-documents$/
const SOURCE_DOCUMENT_INGESTION_REQUEST_LIMIT = 51 * 1024 * 1024

// Parameterized resources cannot be named by their pathname, so they are the one
// explicit table; every other route stays discoverable from `api/`. Each pattern
// only picks the module — the handler owns its exact grammar and answers 404.
const PARAMETERIZED: ReadonlyArray<readonly [RegExp, string]> = [
  [SOURCE_DOCUMENT_INGESTION_ROUTE, 'source_documents'],
  [
    /^\/api\/project-contexts\/[^/]+\/source-documents\/[^/]+\/reopen$/,
    'document_reopen',
  ],
  [
    /^\/api\/project-contexts\/[^/]+\/source-documents\/[^/]+$/,
    'source_documents',
  ],
  [/^\/api\/project-contexts(?:\/[^/]+)?$/, 'project_contexts'],
  [/^\/api\/schema-revisions(?:\/[^/]+)?$/, 'schema_revisions'],
  [/^\/api\/extraction-schemas$/, 'extraction_schemas'],
  [/^\/api\/extractions(?:\/[^/]+)?(?:\/review)?$/, 'extractions'],
  [/^\/api\/batch-extractions$/, 'batch_extractions'],
  [/^\/api\/batch-schema-suggestions$/, 'batch_schema_suggestions'],
  [/^\/api\/source-representations\//, 'source_representations'],
]

/**
 * `api/` is the route list, so an unknown path is a 404 rather than a module
 * load failure. Avoids a second hand-maintained table of handler names.
 */
export function apiHandlerName(pathname: string, root: string): string | null {
  const parameterized = PARAMETERIZED.find(([route]) => route.test(pathname))
  if (parameterized) return parameterized[1]
  const name = API_ROUTE.exec(pathname)?.[1]
  return name && existsSync(join(root, 'api', `${name}.ts`)) ? name : null
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (response.body) Readable.fromWeb(response.body).pipe(res)
  else res.end()
}

// Local dev adapter for the Studio Request/Response handlers under `api/`.
export function apiFunctions(): Plugin {
  return {
    name: 'free-api-functions',
    configureServer(server) {
      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next) => {
          try {
            const pathname = new URL(req.url ?? '/', 'http://localhost')
              .pathname
            if (pathname !== '/api' && !pathname.startsWith('/api/'))
              return next()

            // Never fall through to index.html: a mistyped fetch must fail as JSON
            // rather than as HTML that explodes inside response.json().
            const name = apiHandlerName(pathname, server.config.root)
            if (!name) {
              return await send(
                apiErrorResponse(
                  new ApiError(404, 'not_found', 'API route not found.'),
                ),
                res,
              )
            }

            const mod = await server.ssrLoadModule(`/api/${name}.ts`)
            const handler = mod[req.method ?? 'GET']
            if (typeof handler !== 'function') {
              return await send(
                apiErrorResponse(
                  new ApiError(
                    405,
                    'method_not_allowed',
                    'The requested method is not supported.',
                  ),
                ),
                res,
              )
            }

            const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
            const headers = new Headers()
            for (const [k, v] of Object.entries(req.headers))
              if (!k.startsWith(':'))
                for (const val of Array.isArray(v) ? v : v == null ? [] : [v])
                  headers.append(k, val)

            const request = new Request(`http://localhost${req.url}`, {
              method: req.method,
              headers,
              body: hasBody
                ? await readBody(
                    req,
                    SOURCE_DOCUMENT_INGESTION_ROUTE.test(pathname)
                      ? SOURCE_DOCUMENT_INGESTION_REQUEST_LIMIT
                      : undefined,
                  )
                : undefined,
            })
            await send(await handler(request), res)
          } catch (error) {
            await send(apiErrorResponse(error), res)
          }
        },
      )
    },
  }
}

export async function readBody(
  req: IncomingMessage,
  maxBytes?: number,
): Promise<Buffer> {
  const declared = req.headers['content-length']
  if (
    maxBytes !== undefined &&
    typeof declared === 'string' &&
    /^\d+$/.test(declared) &&
    Number(declared) > maxBytes
  )
    throw new ApiError(413, 'invalid_request', 'The request body is too large.')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    bytes += buffer.byteLength
    if (maxBytes !== undefined && bytes > maxBytes)
      throw new ApiError(413, 'invalid_request', 'The request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

// Keep Studio on IPv4 loopback so dev-container port forwarding reaches the
// same address on every host without exposing the server on the container LAN.
export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    process.env.DATABASE_URL ??= loadEnv(
      mode,
      resolve(import.meta.dirname, '../../packages/db'),
      '',
    ).DATABASE_URL
  }
  return {
    plugins: [react(), tailwindcss(), apiFunctions()],
    server:
      mode === 'https' ? localHttps() : { host: '127.0.0.1' as const },
  }
})

function localHttps() {
  const certificates = resolve(import.meta.dirname, '.certs')
  const cert = join(certificates, 'studio.pem')
  const key = join(certificates, 'studio-key.pem')
  return existsSync(cert) && existsSync(key)
    ? { https: { cert: readFileSync(cert), key: readFileSync(key) } }
    : undefined
}
