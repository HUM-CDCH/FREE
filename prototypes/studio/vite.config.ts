import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError, apiErrorResponse } from './api/_http.js'

// The leading [a-z] keeps `_`-prefixed private modules such as /api/_model_config
// unreachable; handlers themselves declare which methods they export.
const API_ROUTE = /^\/api\/([a-z][a-z_]*)$/

/**
 * `api/` is the route list, so an unknown path is a 404 rather than a module
 * load failure. Avoids a second hand-maintained table of handler names.
 */
export function apiHandlerName(pathname: string, root: string): string | null {
  const name = API_ROUTE.exec(pathname)?.[1]
  return name && existsSync(join(root, 'api', `${name}.ts`)) ? name : null
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (response.body) Readable.fromWeb(response.body).pipe(res)
  else res.end()
}

// ponytail: dev-only stand-in for `vercel dev` so `pnpm dev` serves the Vercel
// `api/*.ts` handlers. Drop this plugin if you switch to `pnpm vercel:dev`.
export function apiFunctions(): Plugin {
  return {
    name: 'free-api-functions',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        try {
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          if (pathname !== '/api' && !pathname.startsWith('/api/')) return next()

          // Never fall through to index.html: a mistyped fetch must fail as JSON
          // rather than as HTML that explodes inside response.json().
          const name = apiHandlerName(pathname, server.config.root)
          if (!name) {
            return await send(
              apiErrorResponse(new ApiError(404, 'not_found', 'API route not found.')),
              res,
            )
          }

          const mod = await server.ssrLoadModule(`/api/${name}.ts`)
          const handler = mod[req.method ?? 'GET']
          if (typeof handler !== 'function') {
            return await send(
              apiErrorResponse(
                new ApiError(405, 'method_not_allowed', 'The requested method is not supported.'),
              ),
              res,
            )
          }

          const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers))
            for (const val of Array.isArray(v) ? v : v == null ? [] : [v]) headers.append(k, val)

          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers,
            body: hasBody ? await readBody(req) : undefined,
          })
          await send(await handler(request), res)
        } catch (error) {
          await send(apiErrorResponse(error), res)
        }
      })
    },
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // ponytail: Vite only exposes VITE_* to the client; the api/* handlers read
  // process.env. Load .env into process.env so `pnpm dev` matches `vercel dev`.
  // Override (not soft-merge): Vite restarts in-process on .env edits, so stale
  // process.env values must be replaced for edits to take effect.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))

  return {
    plugins: [
      react(),
      tailwindcss(),
      apiFunctions(),
    ],
  }
})
