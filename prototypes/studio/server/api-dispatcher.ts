/// <reference types="vite/client" />

import { ApiError, apiErrorResponse } from '../api/_http.js'
import type { ResearcherProjectStore } from 'db'

export const SOURCE_DOCUMENT_INGESTION_REQUEST_LIMIT = 51 * 1024 * 1024

const API_ROUTE = /^\/api\/([a-z][a-z_]*)$/
const SOURCE_DOCUMENT_INGESTION_ROUTE =
  /^\/api\/project-contexts\/[^/]+\/source-documents$/
const SOURCE_DOCUMENT_ROUTE =
  /^\/api\/project-contexts\/[^/]+\/source-documents(?:\/[^/]+)?$/
const SOURCE_DOCUMENT_REOPEN_ROUTE =
  /^\/api\/project-contexts\/[^/]+\/source-documents\/[^/]+\/reopen$/

const PARAMETERIZED: ReadonlyArray<readonly [RegExp, string]> = [
  [SOURCE_DOCUMENT_ROUTE, 'source_documents'],
  [SOURCE_DOCUMENT_REOPEN_ROUTE, 'document_reopen'],
  [/^\/api\/project-contexts(?:\/[^/]+)?$/, 'project_contexts'],
  [/^\/api\/schema-revisions(?:\/[^/]+)?$/, 'schema_revisions'],
  [/^\/api\/extraction-schemas(?:\/[^/]+)?$/, 'extraction_schemas'],
  [/^\/api\/extractions(?:\/[^/]+)?(?:\/review)?$/, 'extractions'],
  [
    /^\/api\/batch-extractions(?:\/[^/]+)?(?:\/results)?$/,
    'batch_extractions',
  ],
  [
    /^\/api\/batch-schema-suggestions(?:\/[^/]+)?(?:\/(?:draft|run|retry))?$/,
    'batch_schema_suggestions',
  ],
  [
    /^\/api\/project-contexts\/[^/]+\/source-representations\/[^/]+\/(?:pdf|markdown|source)$/,
    'source_representations',
  ],
]

const STATIC_API: Readonly<Record<string, true>> = {
  healthz: true,
  model_config: true,
  model_probe: true,
}

export type ApiHandler = (request: Request) => Response | Promise<Response>
export type ApiHandlerModule = Readonly<Record<string, unknown>>
export type ResearcherApiHandlerFactory = (
  store: ResearcherProjectStore,
) => ApiHandlerModule
type ApiRouteEntry =
  | { scope: 'static'; handlers: ApiHandlerModule }
  | {
      scope: 'researcher'
      createHandlers: ResearcherApiHandlerFactory
    }
export type ApiHandlerRegistry = ReadonlyMap<string, ApiRouteEntry>
export type ApiDispatcher = (
  request: Request,
  store: ResearcherProjectStore,
) => Promise<Response>

const eagerModules = import.meta.glob<ApiHandlerModule>(
  [
    '../api/[a-z]*.ts',
  ],
  { eager: true },
)

export function createApiHandlerRegistry(
  modules: Readonly<Record<string, ApiHandlerModule>>,
): ApiHandlerRegistry {
  const registry = new Map<string, ApiRouteEntry>()
  for (const [path, module] of Object.entries(modules)) {
    const match = /\/([a-z][a-z_]*)\.ts$/.exec(path)
    if (!match) continue
    const name = match[1]
    if (registry.has(name))
      throw new Error(`Duplicate API handler module: ${name}`)

    const factory = module.createResearcherApiHandlers
    if (STATIC_API[name]) {
      if (Object.hasOwn(module, 'createResearcherApiHandlers'))
        throw new Error(
          `Static API module ${name} must not export createResearcherApiHandlers.`,
        )
      registry.set(name, { scope: 'static', handlers: module })
      continue
    }

    const moduleHandlers = Object.keys(module).filter((exportName) =>
      /^[A-Z]+$/.test(exportName),
    )
    if (moduleHandlers.length)
      throw new Error(
        `Researcher-scoped API module ${name} must not export module-level handlers.`,
      )
    if (typeof factory !== 'function')
      throw new Error(
        `Researcher-scoped API module ${name} must export createResearcherApiHandlers.`,
      )
    registry.set(name, {
      scope: 'researcher',
      createHandlers: factory as ResearcherApiHandlerFactory,
    })
  }
  return registry
}

const eagerRegistry = createApiHandlerRegistry(eagerModules)

export function apiHandlerName(
  pathname: string,
  registry: ApiHandlerRegistry = eagerRegistry,
): string | null {
  const parameterized = PARAMETERIZED.find(([route]) => route.test(pathname))
  const name = parameterized?.[1] ?? API_ROUTE.exec(pathname)?.[1]
  return name && registry.has(name) ? name : null
}

export function isSourceDocumentIngestionPath(pathname: string): boolean {
  return SOURCE_DOCUMENT_INGESTION_ROUTE.test(pathname)
}

export function createApiDispatcher(
  registry: ApiHandlerRegistry,
): ApiDispatcher {
  return async function dispatchApiRequest(
    request: Request,
    store: ResearcherProjectStore,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname
    const name = apiHandlerName(pathname, registry)
    if (!name)
      return apiErrorResponse(
        new ApiError(404, 'not_found', 'API route not found.'),
      )

    try {
      const entry = registry.get(name)!
      const handlers =
        entry.scope === 'researcher'
          ? entry.createHandlers(store)
          : entry.handlers
      const handler = handlers[request.method.toUpperCase()]
      if (typeof handler !== 'function') {
        const allow = Object.entries(handlers)
          .filter(
            ([method, value]) =>
              /^[A-Z]+$/.test(method) && typeof value === 'function',
          )
          .map(([method]) => method)
          .sort()
        const response = apiErrorResponse(
          new ApiError(
            405,
            'method_not_allowed',
            'The requested method is not supported.',
          ),
        )
        if (allow.length) response.headers.set('Allow', allow.join(', '))
        return response
      }
      return await (handler as ApiHandler)(request)
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export const dispatchApiRequest = createApiDispatcher(eagerRegistry)
