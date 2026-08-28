import type { ExtractionRuntime } from 'extraction'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  applyStudioBaseTag,
  canonicalStudioBasePath,
  studioBaseHref,
} from './shared/studioBasePath.js'
import {
  createDevelopmentOidcIdentityProvider,
  createFakeEntraIdentityProvider,
  createMicrosoftEntraIdentityProvider,
  DEVELOPMENT_ENTRA_CLIENT_ID,
  DEVELOPMENT_ENTRA_TENANT_ID,
} from './server/entraIdentityProvider.js'
import { normalizeEntraCertificateThumbprint } from './server/config.js'

export function developmentStudioOrigin(server: {
  https?: unknown
  host?: string | boolean
  port?: number
}): string {
  const configuredHost = server.host
  const host =
    typeof configuredHost === 'string' &&
    configuredHost !== '0.0.0.0' &&
    configuredHost !== '::'
      ? configuredHost
      : server.https
        ? 'localhost'
        : '127.0.0.1'
  const originHost = host.includes(':') ? `[${host}]` : host
  return `${server.https ? 'https' : 'http'}://${originHost}:${server.port ?? 5173}`
}

function studioBaseHtml(basePath: string): Plugin {
  return {
    name: 'free-studio-base-path',
    transformIndexHtml(html) {
      return applyStudioBaseTag(html, basePath)
    },
  }
}
// Local development invokes the same Hono composition root as the Node host.
export function apiFunctions(configuredBasePath: string): Plugin {
  const basePath = canonicalStudioBasePath(configuredBasePath)
  const generatedSessionSecret = randomBytes(32)
  return {
    name: 'free-api-functions',
    async configureServer(server) {
      const playwrightMode = process.env.FREE_PLAYWRIGHT_AUTH === '1'
      if (playwrightMode && server.config.server.host !== '127.0.0.1')
        throw new Error(
          'Playwright authentication requires Vite to listen on 127.0.0.1.',
        )
      if (server.httpServer) {
        // Use Vite's SSR graph so the lifecycle owns the same singleton loaded
        // by API handlers, after defineConfig has established database settings.
        const runtimeModule = await server.ssrLoadModule(
          '/api/_extraction_runtime.ts',
        )
        const extractionRuntime: ExtractionRuntime =
          runtimeModule.extractionRuntime
        const runtimeAbort = new AbortController()
        const running = extractionRuntime
          .run(runtimeAbort.signal)
          .catch((error) => {
            if (!runtimeAbort.signal.aborted)
              server.config.logger.error(
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              )
          })
        server.httpServer.once('close', () => {
          runtimeAbort.abort()
          void extractionRuntime
            .close()
            .then(() => running)
            .catch((error) => {
              server.config.logger.error(
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              )
            })
        })
      }
      const studioModule = (await server.ssrLoadModule('/server/app.ts')) as {
        createStudioApp(options: {
          studioOrigin: string
          basePath: string
          sessionSecret: Uint8Array
          identityProvider: unknown
          accountStore?: unknown
          playwrightAuthentication?: unknown
          clientHandler: () => Response
          viteDevelopmentAssets: boolean
        }): Promise<unknown>
        viteClientFallback(): Response
        handleStudioNodeRequest(
          app: unknown,
          studioOrigin: string,
          incoming: IncomingMessage,
          outgoing: ServerResponse,
        ): Promise<boolean>
      }
      const environment = loadEnv(
        server.config.mode,
        server.config.root,
        '',
      )
      const developmentOrigin = developmentStudioOrigin(server.config.server)
      const studioOrigin =
        process.env.STUDIO_ORIGIN ??
        environment.STUDIO_ORIGIN ??
        developmentOrigin
      const encodedSecret =
        process.env.FREE_SESSION_SECRET ?? environment.FREE_SESSION_SECRET
      const sessionSecret = encodedSecret
        ? Buffer.from(encodedSecret, 'base64')
        : generatedSessionSecret
      if (
        playwrightMode &&
        !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(
          studioOrigin,
        )
      )
        throw new Error(
          'Playwright authentication is restricted to a loopback Studio origin.',
        )
      const playwright = playwrightMode
        ? await import('./server/playwright-auth.ts')
        : undefined
      const accountStore = playwright?.createPlaywrightAccountStore()
      const playwrightAuthentication =
        playwright?.createPlaywrightAuthentication()
      const environmentValue = (name: string) =>
        process.env[name] ?? environment[name]
      const realEntra =
        !playwrightMode && environmentValue('FREE_ENTRA_REAL') === '1'
      if (realEntra && new URL(studioOrigin).protocol !== 'https:')
        throw new Error('Real Entra development requires an HTTPS Studio origin.')
      const required = (name: string) => {
        const configured = environmentValue(name)
        if (!configured) throw new Error(`${name} is required for real Entra development.`)
        return configured
      }
      // compose.override.yaml points development at its mock OIDC service so
      // every sign-in runs the real MSAL client code; without the mock (Dev
      // Container, host-run dev server) identity falls back to the fake.
      const mockOidcIssuer =
        !playwrightMode && !realEntra
          ? environmentValue('FREE_ENTRA_MOCK_ISSUER')
          : undefined
      const identityProvider = realEntra
        ? createMicrosoftEntraIdentityProvider({
            tenantId: required('FREE_ENTRA_TENANT_ID'),
            clientId: required('FREE_ENTRA_CLIENT_ID'),
            certificateThumbprint: normalizeEntraCertificateThumbprint(
              required('FREE_ENTRA_CLIENT_CERT_THUMBPRINT'),
            ),
            certificatePrivateKey: readFileSync(
              required('FREE_ENTRA_CLIENT_CERT_PATH'),
              'utf8',
            ),
          })
        : mockOidcIssuer
          ? createDevelopmentOidcIdentityProvider({
              tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
              clientId: DEVELOPMENT_ENTRA_CLIENT_ID,
              serverIssuer: mockOidcIssuer,
              browserIssuer:
                environmentValue('FREE_ENTRA_MOCK_BROWSER_ISSUER') ??
                mockOidcIssuer,
            })
          : createFakeEntraIdentityProvider()
      const app = await studioModule.createStudioApp({
        studioOrigin,
        basePath,
        sessionSecret,
        identityProvider,
        accountStore,
        playwrightAuthentication,
        clientHandler: studioModule.viteClientFallback,
        viteDevelopmentAssets: true,
      })

      server.middlewares.use(async (request, response, next) => {
        try {
          const handled = await studioModule.handleStudioNodeRequest(
            app,
            studioOrigin,
            request,
            response,
          )
          if (!handled) next()
        } catch (error) {
          next(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
  }
}

// Keep Studio on IPv4 loopback so dev-container port forwarding reaches the
// same address on every host without exposing the server on the container LAN.
export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, import.meta.dirname, '')
  const basePath = canonicalStudioBasePath(
    process.env.STUDIO_BASE_PATH ?? environment.STUDIO_BASE_PATH ?? '/',
  )
  if (command === 'serve') {
    process.env.DATABASE_URL ??= loadEnv(
      mode,
      resolve(import.meta.dirname, '../..'),
      '',
    ).DATABASE_URL
  }
  return {
    base: command === 'build' ? './' : studioBaseHref(basePath),
    plugins: [
      ...(command === 'serve' ? [studioBaseHtml(basePath)] : []),
      react(),
      tailwindcss(),
      apiFunctions(basePath),
    ],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
    // The Compose development overlay widens the bind with the `--host` CLI
    // flag; the config itself never listens beyond loopback.
    server:
      mode === 'https'
        ? localHttps()
        : { host: '127.0.0.1', port: 5173, strictPort: true },
  }
})

export function localHttps(
  certificates = resolve(import.meta.dirname, '.certs'),
) {
  const cert = join(certificates, 'studio.pem')
  const key = join(certificates, 'studio-key.pem')
  try {
    return { https: { cert: readFileSync(cert), key: readFileSync(key) } }
  } catch (cause) {
    throw new Error(
      `HTTPS mode requires readable certificate files at "${cert}" and "${key}". Create them with mkcert or use "pnpm --filter studio dev" for HTTP.`,
      { cause },
    )
  }
}
