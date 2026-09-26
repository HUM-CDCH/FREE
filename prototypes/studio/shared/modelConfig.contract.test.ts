import { describe, expect, it } from 'vitest'
import {
  INGESTION_MODEL_ROLES,
  PROVIDER_KINDS,
  apiBaseIssue,
  ingestionModelChoiceSchema,
  ingestionModelKeySchema,
  ingestionModelListingSchema,
  ingestionModelRoleSchema,
  isValidApiBase,
  modelConfigSchema,
  modelConfigStateSchema,
  modelConfigUpdateSchema,
  modelConnectionSchema,
  modelProbeRequestSchema,
  routeSchema,
  selectedRoute,
  usesNuextractProtocol,
  uuidSchema,
} from './modelConfig.contract'

/** The stored protocol flag Studio no longer has: the NuExtract protocol is derived, never stored. */
const RETIRED_PROTOCOL = 'nuextract'

describe('model configuration runtime contract', () => {
  it('accepts model selection and rejects output overrides', () => {
    const route = { connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'manual' }
    for (const jsonOutput of ['auto', 'prompt', 'schema', 'native', 'guess']) {
      expect(routeSchema.safeParse({ ...route, jsonOutput }).success).toBe(false)
    }
    expect(routeSchema.parse(route)).toEqual(route)
  })
  it('keeps the exact provider kinds and canonical lowercase UUIDs', () => {
    expect(PROVIDER_KINDS).toEqual([
      'ollama',
      'openai',
      'anthropic',
      'google',
      'codex-cli',
      'claude-code',
      'openai-compatible',
      'vllm',
    ])
    expect(uuidSchema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(true)
    expect(uuidSchema.safeParse('11111111-1111-4111-8111-11111111111A').success).toBe(false)
    expect(modelConfigSchema.safeParse({ connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {}, version: 1 }).success).toBe(false)
  })

  it('parses the empty configuration with an empty Ingestion Model Choice, and nothing without one', () => {
    const empty = { connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {} }
    expect(modelConfigSchema.parse(empty)).toEqual(empty)
    expect(modelConfigSchema.safeParse({ ...empty, ingestionModels: undefined }).success).toBe(false)
  })

  it('a connection records only whether it uses a key, never the key', () => {
    const connection = { id: '11111111-1111-4111-8111-111111111111', name: 'Gateway', provider: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: true }
    expect(modelConnectionSchema.parse(connection)).toEqual(connection)
    expect(modelConnectionSchema.safeParse({ ...connection, hasKey: undefined }).success).toBe(false)
    for (const secret of [{ key: 'sk-test-contract' }, { credential: 'sk-test-contract' }])
      expect(modelConnectionSchema.safeParse({ ...connection, ...secret }).success).toBe(false)
    const config = { connections: [connection], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {} }
    expect(modelConfigUpdateSchema.safeParse({ config }).success).toBe(true)
    expect(modelConfigUpdateSchema.safeParse({ config, credentials: { [connection.id]: 'sk-test-contract' } }).success).toBe(false)
    // What Studio answers about a configuration is the configuration alone.
    expect(Object.keys(modelConfigStateSchema.shape)).toEqual(['config'])
  })

  it('a probe carries at most one bounded key and nothing else', () => {
    const connection = { id: '11111111-1111-4111-8111-111111111111', name: 'vLLM', provider: 'vllm', baseUrl: 'http://vllm:8000/v1', hasKey: false }
    expect(modelProbeRequestSchema.safeParse({ connection }).success).toBe(true)
    expect(modelProbeRequestSchema.safeParse({ connection, credential: 'k'.repeat(8192) }).success).toBe(true)
    for (const credential of [null, '', 'k'.repeat(8193), 42])
      expect(modelProbeRequestSchema.safeParse({ connection, credential }).success).toBe(false)
  })

  it('stores no NuExtract protocol on a route', () => {
    const route = { connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'numind/NuExtract3-FP8' }
    const config = { connections: [], routes: { schemaSuggestion: route, interaction: null }, extractionModels: {}, ingestionModels: {} }
    expect(modelConfigSchema.parse(config)).toEqual(config)
    expect(modelConfigSchema.safeParse({
      ...config, routes: { ...config.routes, schemaSuggestion: { ...route, protocol: RETIRED_PROTOCOL } },
    }).success).toBe(false)
  })

  it.each([
    [true, 'numind/NuExtract3-FP8', true],
    [true, 'NUMIND/nuextract-2.0-8b', true],
    [true, 'Qwen/Qwen3.8-27B-FP8', false],
    [false, 'numind/NuExtract3-FP8', false],
    [false, 'Qwen/Qwen3.8-27B-FP8', false],
  ])('usesNuextractProtocol(supportsNuextract %s, %s) is %s', (supportsNuextract, modelId, expected) => {
    expect(usesNuextractProtocol({ supportsNuextract }, modelId)).toBe(expected)
  })

  it('selects Schema Suggestion\'s own route, else the Interaction Route, else the deployment default', () => {
    const own = { connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'own' }
    const interaction = { connectionId: '22222222-2222-4222-8222-222222222222', modelId: 'assistant' }
    const fallback = { connectionId: '33333333-3333-4333-8333-333333333333', modelId: 'default' }
    expect(selectedRoute({ schemaSuggestion: own, interaction }, 'schemaSuggestion', fallback)).toBe(own)
    expect(selectedRoute({ schemaSuggestion: null, interaction }, 'schemaSuggestion', fallback)).toBe(interaction)
    expect(selectedRoute({ schemaSuggestion: null, interaction: null }, 'schemaSuggestion', fallback)).toBe(fallback)
    expect(selectedRoute({ schemaSuggestion: null, interaction: null }, 'schemaSuggestion', null)).toBeNull()
    // The Interaction Route never borrows Schema Suggestion's.
    expect(selectedRoute({ schemaSuggestion: own, interaction: null }, 'interaction', fallback)).toBe(fallback)
    expect(selectedRoute({ schemaSuggestion: own, interaction: null }, 'interaction', null)).toBeNull()
  })

  it.each([
    [' https://host.example/v1', 'API base must not have surrounding whitespace.'],
    ['https://host.example/v1\n', 'API base must not have surrounding whitespace.'],
    ['https://host.exa\u0001mple/v1', 'API base must not contain control characters.'],
    ['https://host.example\\v1', 'API base must not contain backslashes.'],
    ['host.example/v1', 'API base must be an absolute HTTP or HTTPS URL.'],
    ['ftp://host.example/v1', 'API base must be an absolute HTTP or HTTPS URL.'],
    ['https://', 'API base must be an absolute HTTP or HTTPS URL.'],
    ['https://user@host.example/v1', 'API base must not contain embedded userinfo.'],
    ['https://@host.example/v1', 'API base must not contain embedded userinfo.'],
    ['https://host.example/v1?models=1', 'API base must not contain a query.'],
    ['https://host.example/v1#models', 'API base must not contain a fragment.'],
  ])('rejects unsafe API base %s', (value, issue) => {
    expect(apiBaseIssue(value)).toBe(issue)
    expect(isValidApiBase(value)).toBe(false)
  })

  it.each(['http://localhost:11434/api', 'https://host.example/v1', 'https://host.example/v1/'])(
    'preserves valid API base %s',
    (value) => {
      expect(apiBaseIssue(value)).toBeNull()
      expect(isValidApiBase(value)).toBe(true)
    },
  )

  it('rejects a null API base in the UI predicate', () => {
    expect(isValidApiBase(null)).toBe(false)
  })
})

describe('Ingestion Model Choice', () => {
  it('stores either role\'s key and refuses an unknown role or an empty or overlong key', () => {
    expect(ingestionModelChoiceSchema.parse({})).toEqual({})
    expect(ingestionModelChoiceSchema.parse({ ocr: 'surya', layout: 'no-longer-listed' })).toEqual({ ocr: 'surya', layout: 'no-longer-listed' })
    for (const invalid of [{ table: 'x' }, { ocr: '' }, { layout: 'x'.repeat(129) }])
      expect(ingestionModelChoiceSchema.safeParse(invalid).success).toBe(false)
  })
})

describe('ingestion model listing contract', () => {
  const listing = {
    defaults: { ocr: 'surya', layout: 'layout_heron_101' },
    models: {
      ocr: [{ key: 'surya', label: 'datalab-to/surya-ocr-2', serving: true }],
      layout: [{ key: 'layout_heron_101', label: 'Heron-101', serving: true }],
    },
  }

  it('round-trips kei\'s listing and names exactly the two roles', () => {
    expect(INGESTION_MODEL_ROLES).toEqual(['ocr', 'layout'])
    expect(ingestionModelRoleSchema.safeParse('fields').success).toBe(false)
    expect(ingestionModelListingSchema.parse(JSON.parse(JSON.stringify(listing)))).toEqual(listing)
  })

  it('refuses a listing with a missing role, an extra field or an empty or overlong key', () => {
    for (const invalid of [
      { ...listing, defaults: { ocr: 'surya' } },
      { ...listing, models: { ocr: listing.models.ocr } },
      { ...listing, extra: true },
      { ...listing, models: { ...listing.models, ocr: [{ ...listing.models.ocr[0], repo: 'x' }] } },
      { ...listing, defaults: { ...listing.defaults, ocr: '' } },
      { ...listing, defaults: { ...listing.defaults, layout: 'x'.repeat(129) } },
    ])
      expect(ingestionModelListingSchema.safeParse(invalid).success).toBe(false)
    expect(ingestionModelKeySchema.parse('x'.repeat(128))).toHaveLength(128)
  })
})
