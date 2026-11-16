import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  activeMethod, activeSettings, accountMethod, ARTICLE_REFERENCE_CONTEXT_TOKENS, canonicalArticle,
  canonicalExtractionSettings, canonicalIntent, extractionMethod, extractionSettingsIssues, extractionSettingsSchema,
  identityFieldIssues, identityFieldsMessage, keiMethodOptions, METHOD_MESSAGES, REFERENCE_ARTICLE, UNRECORDED_ARTICLE,
  storedSettings, UNIFIED_CATALOG_DEFAULTS, UNIFIED_CATALOG_PRO_VERSION, unifiedCatalogSettingsSchema, validateArticleOptions,
  type ActiveSettings, type ArticleSettings, type ExtractionSettings,
} from './extraction-method.js'
import { ExtractionError } from './errors.js'
import { gliformerIssues } from './gliformer-compatibility.js'
import { parseSchemaDefinition } from './schema.js'

const FIXTURES = new URL('../../../apps/parsing_service/tests/fixtures/contracts/', import.meta.url)
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))

type Inventory = { context_tokens: number; identity_fields: string[]; factors: Record<string, unknown[]>; accepted: number; rejected: number; verdicts: string }

/** itertools.product over the fixture's factors in key order: the last factor varies fastest. */
function* inventoryInputs(inventory: Inventory): Generator<Record<string, unknown>> {
  const names = Object.keys(inventory.factors)
  const walk = function* (index: number, chosen: Record<string, unknown>): Generator<Record<string, unknown>> {
    if (index === names.length) {
      const input = Object.fromEntries(Object.entries(chosen).filter(([, value]) => value !== null))
      yield { ...input, context_tokens: inventory.context_tokens,
        identity_fields: chosen.identity === 'conservative' ? inventory.identity_fields : [] }
      return
    }
    for (const value of inventory.factors[names[index]!]!) yield* walk(index + 1, { ...chosen, [names[index]!]: value })
  }
  yield* walk(0, {})
}

test('the shared contract cases get the service verdicts and, when accepted, its exact dump', () => {
  const { cases } = fixture('article-options') as { cases: Array<{ id: string; input: unknown; accepted: boolean; canonical?: unknown }> }
  assert.equal(cases.length, 20)
  for (const item of cases) {
    const result = validateArticleOptions(item.input)
    assert.equal(result.ok, item.accepted, item.id)
    if (result.ok) assert.deepEqual(canonicalArticle(result.value), item.canonical, item.id)
  }
})

test('every categorical combination gets the verdict the service gives it', () => {
  const inventory = fixture('article-options').inventory as Inventory
  const mismatches: string[] = []
  let index = 0
  for (const input of inventoryInputs(inventory)) {
    const expected = inventory.verdicts[index] === '1'
    if (validateArticleOptions(input).ok !== expected && mismatches.length < 10)
      mismatches.push(`#${index} ${JSON.stringify(input)} service=${expected}`)
    index += 1
  }
  assert.equal(index, 12288)
  assert.deepEqual(mismatches, [])
  assert.deepEqual([inventory.accepted, inventory.rejected], [3016, 9272])
})

test('cross-field refusals name their field with the design copy', () => {
  const issues = (input: Record<string, unknown>) => {
    const result = validateArticleOptions(input)
    return result.ok ? [] : result.issues
  }
  assert.deepEqual(issues({ overlap_passages: 1 }), [{ path: 'overlap_passages', message: METHOD_MESSAGES.bounded }])
  assert.deepEqual(issues({ selection: 'supported' }), [{ path: 'selection', message: METHOD_MESSAGES.bounded }])
  assert.deepEqual(issues({ grouping: 'structural' }), [{ path: 'grouping', message: METHOD_MESSAGES.bounded }])
  assert.deepEqual(issues({ evidence_policy: 'schema' }), [{ path: 'evidence_policy', message: METHOD_MESSAGES.schemaPolicy }])
  assert.deepEqual(issues({ grounding: 'off', grounding_schedule: 'unresolved' }), [{ path: 'grounding_schedule', message: METHOD_MESSAGES.schedule }])
  assert.deepEqual(issues({ grounding: 'spans', grounding_routing: 'origin_lexical' }), [{ path: 'grounding_routing', message: METHOD_MESSAGES.routing }])
  assert.deepEqual(issues({ identity: 'conservative' }), [{ path: 'identity_fields', message: METHOD_MESSAGES.identity }])
  assert.equal(METHOD_MESSAGES.bounded, 'This choice requires bounded source units.')
  assert.equal(METHOD_MESSAGES.routing, 'Use generated quotes or source spans, and stop after support.')
})

test('numeric and key boundaries: minima, integers, overlap ceiling, duplicate and empty names, unknown factors', () => {
  const refused = (input: Record<string, unknown>, path: string, message: string) => {
    const result = validateArticleOptions(input)
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.ok(!result.ok && result.issues.some((issue) => issue.path === path && issue.message === message), JSON.stringify(result))
  }
  assert.equal(validateArticleOptions({ context: 'bounded', context_tokens: 8192 }).ok, true)
  refused({ context: 'bounded', context_tokens: 8191 }, 'context_tokens', METHOD_MESSAGES.contextTokens)
  refused({ context: 'bounded', context_tokens: 8192.5 }, 'context_tokens', METHOD_MESSAGES.contextTokens)
  refused({ context: 'bounded', context_tokens: '12288' }, 'context_tokens', METHOD_MESSAGES.contextTokens)
  refused({ context: 'bounded', overlap_passages: 3 }, 'overlap_passages', METHOD_MESSAGES.overlap)
  refused({ identity_fields: ['species', 'species'] }, 'identity_fields', METHOD_MESSAGES.identityNames)
  refused({ identity_fields: [''] }, 'identity_fields.0', METHOD_MESSAGES.identityNames)
  // Bounded like any account-owned input: a record identity is a few scalar fields with ordinary names.
  assert.equal(validateArticleOptions({ identity_fields: Array.from({ length: 32 }, (_, index) => `f${index}`) }).ok, true)
  refused({ identity_fields: Array.from({ length: 33 }, (_, index) => `f${index}`) }, 'identity_fields', METHOD_MESSAGES.identityLimit)
  assert.equal(validateArticleOptions({ identity_fields: ['x'.repeat(128)] }).ok, true)
  refused({ identity_fields: ['x'.repeat(129)] }, 'identity_fields.0', METHOD_MESSAGES.identityLimit)
  assert.equal(validateArticleOptions({ span_grounding_version: 1 }).ok, false)
  const catalog = (value: unknown) => extractionSettingsSchema.safeParse({ catalog: value })
  assert.equal(catalog({ generic: { discovery_chars: 1000, record_chars: 1000 } }).success, false)
  assert.equal(catalog({ generic: { discovery_chars: 999 } }).success, false)
  assert.equal(catalog({ recipe: { input_tokens: 64, output_tokens: 64 } }).success, false)
  assert.equal(catalog({ recipe: { output_tokens: 63 } }).success, false)
  assert.equal(catalog({ recipe: { factors: { glossary: false, vocabulary: false } } }).success, false)
})

test('canonical settings: full Article, no nulls, the unused ceiling restored, empty Catalog members dropped', () => {
  const parsed = extractionSettingsSchema.parse({
    article: { context: 'full', context_tokens: 16384, grounding_schedule: null, selection: null },
    catalog: { unified: { verification: false } },
  })
  assert.deepEqual(extractionSettingsIssues(parsed), [])
  const canonical = canonicalExtractionSettings(parsed)
  assert.deepEqual(canonical, {
    article: { ...UNRECORDED_ARTICLE, context_tokens: ARTICLE_REFERENCE_CONTEXT_TOKENS },
    catalog: { unified: { verification: false } },
  })
  assert.deepEqual(Object.keys(canonical.article!), ['context', 'context_tokens', 'overlap_passages', 'identity', 'identity_fields', 'prompt', 'grounding'])
  assert.deepEqual(canonicalExtractionSettings(extractionSettingsSchema.parse({ catalog: {} })), {})
  // An explicit Article is never an omission: it changes the service's artifact.
  assert.deepEqual(canonicalExtractionSettings(extractionSettingsSchema.parse({ article: {} })), { article: UNRECORDED_ARTICLE })
})

const EXPLORE: ArticleSettings = {
  context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
  prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
}

test('the exact wire example: strategy, models and every active option, nothing invented', () => {
  const method = extractionMethod('ARTICLE', { fields: 'instruct', reasoning: 'instruct' }, { article: EXPLORE })
  assert.deepEqual(keiMethodOptions(method), {
    strategy: 'article',
    models: { fields: 'instruct', reasoning: 'instruct' },
    article: {
      context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
    },
  })
})

test('service defaults are recorded and sent explicitly; a recorded null still sends no Article', () => {
  const defaults = activeMethod(null, {}, 'ARTICLE')
  assert.deepEqual(defaults, activeMethod(null, { article: REFERENCE_ARTICLE }, 'ARTICLE'))
  assert.deepEqual(defaults, { models: null, settings: { article: REFERENCE_ARTICLE } })
  assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, defaults.settings)).article, {
    context: 'full', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'reference', grounding: 'semantic', grounding_overflow: 'windows',
  })
  // An Extraction admitted before recorded `article: null`: Resume and Retry send no Article (the whole source).
  const recorded = canonicalIntent({ models: null, settings: { article: null } }, 'ARTICLE')
  assert.deepEqual(recorded, { models: null, settings: { article: null } })
  assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, recorded!.settings)), { strategy: 'article' })
  const { grounding_overflow: _windows, ...unwindowed } = REFERENCE_ARTICLE
  assert.deepEqual(UNRECORDED_ARTICLE, unwindowed)
})

test('an account document yields the active descriptor; only the chosen strategy counts', () => {
  const document = {
    connections: [], routes: {}, ingestionModels: {},
    extractionModels: { fields: 'nuextract' },
    extractionSettings: { article: EXPLORE, catalog: { unified: { input_tokens: 30000 } } },
  }
  assert.deepEqual(accountMethod(document, 'ARTICLE'), { models: { fields: 'nuextract' }, settings: { article: EXPLORE } })
  assert.deepEqual(accountMethod(document, 'CATALOG'), { models: { fields: 'nuextract' }, settings: { unified: { defaults: 10, input_tokens: 30000 } } })
  assert.deepEqual(accountMethod(null, 'CATALOG'), { models: null, settings: { unified: { defaults: 10 } } })
  assert.throws(() => accountMethod({ extractionModels: {}, extractionSettings: { article: { overlap_passages: 1 } } }, 'ARTICLE'),
    (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_model_config')
})

test('a submitted intent is canonicalized, and one for another strategy is refused', () => {
  assert.deepEqual(canonicalIntent({ models: {}, settings: { article: { ...EXPLORE, grouping: null } } }, 'ARTICLE'),
    { models: null, settings: { article: EXPLORE } })
  assert.equal(canonicalIntent({ models: null, settings: { generic: {} } }, 'CATALOG'), null)
  assert.equal(canonicalIntent({ models: null, settings: { article: null } }, 'CATALOG'), null)
  assert.equal(canonicalIntent({ models: null, settings: { article: { overlap_passages: 1 } } }, 'ARTICLE'), null)
  assert.equal(canonicalIntent({ models: null, settings: { unified: { defaults: 10 } }, preset: 'best' }, 'CATALOG'), null)
})

test('a stored snapshot is read back, and one for another strategy is an invalid method', () => {
  assert.equal(storedSettings(null, 'ARTICLE'), null)
  assert.deepEqual(storedSettings({ article: EXPLORE }, 'ARTICLE'), { article: EXPLORE })
  assert.throws(() => storedSettings({ unified: { defaults: 10 } }, 'ARTICLE'),
    (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_extraction_method')
})

test('identity fields are checked against the pinned schema exactly as the shared fixture says', () => {
  const shared = fixture('identity-fields') as { schema: unknown; cases: Array<{ fields: string[]; issues: unknown[] }> }
  const nodes = parseSchemaDefinition(shared.schema).schemaNodes
  for (const item of shared.cases) assert.deepEqual(identityFieldIssues(nodes, item.fields), item.issues, item.fields.join())
  assert.equal(
    identityFieldsMessage(identityFieldIssues(nodes, ['Species', 'tags'])),
    'These identity fields are not scalar record fields of the selected Schema Revision: Species (not in this schema), tags (not a single value).',
  )
})

test('the unified Catalog defaults and option bounds are the service\'s', () => {
  const shared = fixture('unified-catalog-options') as { defaults: Record<string, unknown>; valid: unknown[]; invalid: unknown[] }
  assert.deepEqual(shared.defaults, UNIFIED_CATALOG_DEFAULTS)
  for (const options of shared.valid) assert.deepEqual(unifiedCatalogSettingsSchema.parse(options), options)
  // An Extraction recorded under any defaults version stays readable after the next one is added.
  for (const version of Object.keys(UNIFIED_CATALOG_DEFAULTS).map(Number))
    assert.equal(unifiedCatalogSettingsSchema.safeParse({ defaults: version }).success, true, `defaults ${version}`)
  for (const options of shared.invalid)
    assert.equal(unifiedCatalogSettingsSchema.safeParse(options).success, false, JSON.stringify(options))
})


test('heading candidate overrides survive saved settings and pinned defaults 7 methods', () => {
  const settings: ExtractionSettings = { catalog: { unified: { candidates: 8, headings: true } } }
  assert.deepEqual(canonicalExtractionSettings(settings), settings)
  const pinned = { unified: { defaults: 7 as const, candidates: 8, headings: true } }
  assert.deepEqual(storedSettings(pinned, 'CATALOG'), pinned)
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, pinned)), {
    strategy: 'catalog', ...pinned,
  })
  assert.deepEqual(canonicalIntent({ models: null, settings: pinned }, 'CATALOG'), { models: null, settings: pinned })
})


test('Catalog always pins unified defaults and refuses retired methods and preferences', () => {
  assert.deepEqual(activeMethod(null, {}, 'CATALOG'), { models: null, settings: { unified: { defaults: 10 } } })
  assert.deepEqual(accountMethod(null, 'CATALOG'), activeMethod(null, {}, 'CATALOG'))
  for (const settings of [{ generic: null }, { recipe: null }]) {
    assert.equal(canonicalIntent({ models: null, settings }, 'CATALOG'), null)
    assert.throws(() => storedSettings(settings, 'CATALOG'), ExtractionError)
    assert.throws(() => accountMethod({ extractionModels: {}, extractionSettings: { catalog: settings } }, 'CATALOG'), ExtractionError)
  }
  assert.throws(() => keiMethodOptions(extractionMethod('CATALOG', null, null)), ExtractionError)
  const method = activeMethod(null, { article: EXPLORE, catalog: { unified: { verification: true, overlap: 0 } } }, 'CATALOG')
  assert.deepEqual(method.settings, { unified: { defaults: UNIFIED_CATALOG_PRO_VERSION, overlap: 0, verification: true } })
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, method.settings)), { strategy: 'catalog', ...method.settings })
  assert.ok(gliformerIssues({ models: { fields: 'gliformer' }, settings: method.settings }, []).includes('verification must be Auto or off'))
  assert.equal(canonicalIntent(method, 'ARTICLE'), null)
  const reordered = { catalog: { unified: { verification: true, overlap: 0 } } }
  assert.equal(JSON.stringify(canonicalExtractionSettings(reordered)), JSON.stringify(canonicalExtractionSettings({ catalog: { unified: { overlap: 0, verification: true } } })))
})
