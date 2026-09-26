import type { ResearcherProjectStore } from 'db'
import { describe, expect, it, vi } from 'vitest'
import {
  apiHandlerName,
  createApiDispatcher,
  createApiHandlerRegistry,
  dispatchApiRequest,
  isSourceDocumentIngestionPath,
} from './api-dispatcher.js'

const STORE = {
  researcherAccountId: '10000000-0000-4000-8000-000000000001',
} as ResearcherProjectStore

function scopedModule() {
  return { createResearcherApiHandlers: () => ({}) }
}

function registryWith(
  handlers: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
) {
  return createApiHandlerRegistry(
    Object.fromEntries(
      Object.entries(handlers).map(([name, module]) => [
        `../api/${name}.ts`,
        module,
      ]),
    ),
  )
}

describe('eager API dispatcher', () => {
  it('preserves the exact simple and parameterized route grammar', () => {
    const registry = registryWith({
      healthz: {},
      chat: scopedModule(),
      edit_schema: scopedModule(),
      generate_schema: scopedModule(),
      project_contexts: scopedModule(),
      source_documents: scopedModule(),
      document_reopen: scopedModule(),
      schema_revisions: scopedModule(),
      extraction_schemas: scopedModule(),
      extraction_models: scopedModule(),
      ingestion_models: scopedModule(),
      extractions: scopedModule(),
      batch_extractions: scopedModule(),
      batch_schema_suggestions: scopedModule(),
      source_representations: scopedModule(),
    })

    for (const [pathname, handler] of [
      ['/api/healthz', 'healthz'],
      ['/api/chat', 'chat'],
      ['/api/edit_schema', 'edit_schema'],
      ['/api/generate_schema', 'generate_schema'],
      ['/api/project-contexts', 'project_contexts'],
      ['/api/project-contexts/project', 'project_contexts'],
      [
        '/api/project-contexts/project/source-documents',
        'source_documents',
      ],
      [
        '/api/project-contexts/project/source-documents/document',
        'source_documents',
      ],
      [
        '/api/project-contexts/project/source-documents/document/reopen',
        'document_reopen',
      ],
      ['/api/schema-revisions/revision', 'schema_revisions'],
      ['/api/extraction-schemas/schema', 'extraction_schemas'],
      ['/api/extraction-models', 'extraction_models'],
      ['/api/ingestion-models', 'ingestion_models'],
      ['/api/extractions/extraction/review', 'extractions'],
      ['/api/extractions/extraction/review/draft', 'extractions'],
      ['/api/extractions/extraction/review/reset', 'extractions'],
      ['/api/batch-extractions/batch/results', 'batch_extractions'],
      [
        '/api/batch-schema-suggestions/suggestion/retry',
        'batch_schema_suggestions',
      ],
      [
        '/api/project-contexts/project/source-representations/representation/pdf',
        'source_representations',
      ],
    ] as const)
      expect(apiHandlerName(pathname, registry)).toBe(handler)

    for (const pathname of [
      '/api/_model_config',
      '/api/llm_inspector',
      '/api/nope',
      '/api/healthz/anything',
      '/api/extraction-models/instruct',
      '/api/ingestion-models/surya',
      '/api/batch-extractions/batch/results/anything',
      '/api/source-representations/representation/pdf',
      '/api/project-contexts/project/source-representations/representation/pdf/anything',
      '/api/source-representations/representation/pdf/anything',
      '/api/../package.json',
      '/api/',
    ])
      expect(apiHandlerName(pathname, registry)).toBeNull()
  })

  it('dispatches a known method and returns JSON 404/405 without invoking it otherwise', async () => {
    const get = vi.fn(() => Response.json({ ok: true }))
    const dispatch = createApiDispatcher(registryWith({ healthz: { GET: get } }))

    const found = await dispatch(
      new Request('https://studio.example/api/healthz'),
      STORE,
    )
    expect(found.status).toBe(200)
    await expect(found.json()).resolves.toEqual({ ok: true })
    expect(get).toHaveBeenCalledTimes(1)

    const wrongMethod = await dispatch(
      new Request('https://studio.example/api/healthz', { method: 'POST' }),
      STORE,
    )
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET')
    await expect(wrongMethod.json()).resolves.toEqual({
      error: {
        code: 'method_not_allowed',
        message: 'The requested method is not supported.',
      },
    })
    expect(get).toHaveBeenCalledTimes(1)

    const missing = await dispatch(
      new Request('https://studio.example/api/not-a-route'),
      STORE,
    )
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      error: { code: 'not_found', message: 'API route not found.' },
    })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('constructs scoped handlers from only the request account store', async () => {
    const get = vi.fn(() => Response.json({ account: STORE.researcherAccountId }))
    const createResearcherApiHandlers = vi.fn(() => ({ GET: get }))
    const dispatch = createApiDispatcher(
      registryWith({
        project_contexts: { createResearcherApiHandlers },
      }),
    )

    const response = await dispatch(
      new Request('https://studio.example/api/project-contexts'),
      STORE,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      account: STORE.researcherAccountId,
    })
    expect(createResearcherApiHandlers).toHaveBeenCalledOnce()
    expect(createResearcherApiHandlers).toHaveBeenCalledWith(STORE)
    expect(get).toHaveBeenCalledOnce()
  })

  it('rejects unscoped project handlers and factories on static modules', () => {
    expect(() =>
      registryWith({ project_contexts: { GET: () => new Response() } }),
    ).toThrow(/must not export module-level handlers/)
    expect(() => registryWith({ project_contexts: {} })).toThrow(
      /must export createResearcherApiHandlers/,
    )
    expect(() =>
      registryWith({
        healthz: { createResearcherApiHandlers: () => ({}) },
      }),
    ).toThrow(/Static API module healthz/)
  })

  it('uses the eager production registry without filesystem discovery', async () => {
    const response = await dispatchApiRequest(
      new Request('https://studio.example/api/healthz'),
      STORE,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(apiHandlerName('/api/llm_inspector')).toBeNull()
  })

  it('recognizes only the source-document collection as an ingestion path', () => {
    expect(
      isSourceDocumentIngestionPath(
        '/api/project-contexts/project/source-documents',
      ),
    ).toBe(true)
    expect(
      isSourceDocumentIngestionPath(
        '/api/project-contexts/project/source-documents/document',
      ),
    ).toBe(false)
  })
})
