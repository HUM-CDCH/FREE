import { defineConfig, type Plugin } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ponytail: dev-only stand-in for `vercel dev` so `pnpm dev` serves the Vercel
// `api/*.ts` handlers. Drop this plugin if you switch to `pnpm vercel:dev`.
function apiFunctions(): Plugin {
  return {
    name: 'free-api-functions',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const match = /^\/api\/([a-z_]+)(?:[/?]|$)/.exec(req.url ?? '')
        if (!match) return next()
        try {
          const mod = await server.ssrLoadModule(`/api/${match[1]}.ts`)
          const handler = mod[req.method ?? 'GET']
          if (typeof handler !== 'function') return next()

          const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers))
            for (const val of Array.isArray(v) ? v : v == null ? [] : [v]) headers.append(k, val)

          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers,
            body: hasBody ? await readBody(req) : undefined,
          })
          const response: Response = await handler(request)

          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          if (response.body) Readable.fromWeb(response.body).pipe(res)
          else res.end()
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ detail: String(error) }))
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
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    apiFunctions(),
  ],
})
