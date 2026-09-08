import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  canonicalEntraCertificateThumbprint,
  canonicalStudioBasePath,
  canonicalStudioSessionSecret,
} from 'studio-configuration'
import {
  applyStudioBaseTag,
  studioBaseHref,
} from './shared/studioBasePath.js'
import {
  createDevelopmentOidcIdentityProvider,
  createMicrosoftEntraIdentityProvider,
  DEVELOPMENT_ENTRA_CLIENT_ID,
  DEVELOPMENT_ENTRA_TENANT_ID,
} from './server/entraIdentityProvider.js'
import { createDevelopmentHost } from './server/developmentHost.js'

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

type StudioServerModule = {
  createStudioApp(options: {
    studioOrigin: string
    basePath: string
    sessionSecret: Uint8Array
    identityProvider: unknown
    clientHandler: () => Response
    viteDevelopmentAssets: boolean
  }): Promise<unknown>
  viteClientFallback(): Response
  handleStudioNodeRequest(...args: unknown[]): Promise<boolean>
}

// One loaded composition root: the module that dispatches a request, the
// application it composed, and the origin that application enforces.
type StudioComposition = {
  studio: StudioServerModule
  app: unknown
  studioOrigin: string
}

// Local development invokes the same Hono composition root as the Node host,
// and recomposes it whenever a server module it loaded changes. Vite
// invalidates the SSR module graph upwards, from the edited file through its
// importers, so recomposition re-evaluates exactly the changed server code
// while process-wide singletons its dependencies own — the database pool, the
// Extraction runtime — stay the instances already loaded.
export function apiFunctions(configuredBasePath: string): Plugin {
  const basePath = canonicalStudioBasePath(configuredBasePath)
  const generatedSessionSecret = randomBytes(32)
  return {
    name: 'free-api-functions',
    async configureServer(server) {
      const composeStudio = async (): Promise<StudioComposition> => {
        const studio = (await server.ssrLoadModule(
          '/server/app.ts',
        )) as StudioServerModule
        const environment = loadEnv(server.config.mode, server.config.root, '')
        const developmentOrigin = developmentStudioOrigin(server.config.server)
        const studioOrigin =
          process.env.STUDIO_ORIGIN ??
          environment.STUDIO_ORIGIN ??
          developmentOrigin
        const encodedSecret =
          process.env.FREE_SESSION_SECRET ?? environment.FREE_SESSION_SECRET
        const sessionSecret = encodedSecret
          ? canonicalStudioSessionSecret(encodedSecret)
          : generatedSessionSecret
        const environmentValue = (name: string) =>
          process.env[name] ?? environment[name]
        const realEntra = environmentValue('FREE_ENTRA_REAL') === '1'
        if (realEntra && new URL(studioOrigin).protocol !== 'https:')
          throw new Error(
            'Real Entra development requires an HTTPS Studio origin.',
          )
        const required = (name: string) => {
          const configured = environmentValue(name)
          if (!configured)
            throw new Error(`${name} is required for development sign-in.`)
          return configured
        }
        // compose.override.yaml points development at its mock OIDC service so
        // every sign-in runs the real MSAL client code and session path.
        const identityProvider = realEntra
          ? createMicrosoftEntraIdentityProvider({
              tenantId: required('FREE_ENTRA_TENANT_ID'),
              clientId: required('FREE_ENTRA_CLIENT_ID'),
              certificateThumbprint: canonicalEntraCertificateThumbprint(
                required('FREE_ENTRA_CLIENT_CERT_THUMBPRINT'),
              ),
              certificatePrivateKey: readFileSync(
                required('FREE_ENTRA_CLIENT_CERT_PATH'),
                'utf8',
              ),
            })
          : createDevelopmentOidcIdentityProvider({
              tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
              clientId: DEVELOPMENT_ENTRA_CLIENT_ID,
              serverIssuer: required('FREE_ENTRA_MOCK_ISSUER'),
              browserIssuer:
                environmentValue('FREE_ENTRA_MOCK_BROWSER_ISSUER') ??
                required('FREE_ENTRA_MOCK_ISSUER'),
            })
        const app = await studio.createStudioApp({
          studioOrigin,
          basePath,
          sessionSecret,
          identityProvider,
          clientHandler: studio.viteClientFallback,
          viteDevelopmentAssets: true,
        })
        return { studio, app, studioOrigin }
      }

      const developmentHost = await createDevelopmentHost(server, composeStudio)

      server.middlewares.use(async (request, response, next) => {
        try {
          const { studio, app, studioOrigin } =
            await developmentHost.composition()
          const handled = await studio.handleStudioNodeRequest(
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

export function pdfjsWasmAssets(command: 'serve' | 'build', root = import.meta.dirname): Plugin {
  const prepare = () => {
    const source = resolve(root, 'node_modules/pdfjs-dist/wasm')
    const parent = resolve(root, 'public/assets')
    const destination = join(parent, 'pdfjs-wasm')
    if (existsSync(destination) || !existsSync(source)) return

    mkdirSync(parent, { recursive: true })
    const temporary = mkdtempSync(join(parent, '.pdfjs-wasm-'))
    try {
      cpSync(source, temporary, { recursive: true })
      try {
        // Publish only a complete directory; another process may publish first.
        renameSync(temporary, destination)
      } catch (error) {
        if (!existsSync(destination)) throw error
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  return {
    name: 'free-pdfjs-wasm',
    configureServer: prepare,
    buildStart() {
      if (command === 'build') prepare()
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
      ...(process.env.VITEST ? [] : [pdfjsWasmAssets(command)]),
      ...(command === 'serve' ? [studioBaseHtml(basePath)] : []),
      react(),
      tailwindcss(),
      apiFunctions(basePath),
    ],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
    // Signed-out pages load the shared browser configuration without a
    // session. Pre-bundle the linked workspace package so Vite serves it from
    // the public dependency path rather than an authenticated /@fs path.
    optimizeDeps: { include: ['studio-configuration'] },
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
