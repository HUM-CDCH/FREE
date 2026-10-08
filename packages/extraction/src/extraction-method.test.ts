import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  activeMethod, activeSettings, accountMethod, ARTICLE_REFERENCE_CONTEXT_TOKENS, canonicalArticle,
  canonicalExtractionSettings, canonicalIntent, extractionMethod, extractionSettingsIssues, extractionSettingsSchema,
  identityFieldIssues, identityFieldsMessage, keiMethodOptions, METHOD_MESSAGES, REFERENCE_ARTICLE, REFERENCE_CATALOG,
  storedSettings, UNIFIED_CATALOG_DEFAULTS, unifiedCatalogEnabled, unifiedCatalogSettingsSchema, validateArticleOptions,
  type ActiveSettings, type ArticleSettings, type ExtractionSettings,
} from './extraction-method.js'
import { ExtractionError } from './errors.js'
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

test('the nineteen contract cases get the service verdicts and, when accepted, its exact dump', () => {
  const { cases } = fixture('article-options') as { cases: Array<{ id: string; input: unknown; accepted: boolean; canonical?: unknown }> }
  assert.equal(cases.length, 19)
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
  assert.equal(index, 6144)
  assert.deepEqual(mismatches, [])
  assert.deepEqual([inventory.accepted, inventory.rejected], [1560, 4584])
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
  assert.equal(catalog({ generic: { discovery_chars: 1000, record_chars: 1000 } }).success, true)
  assert.equal(catalog({ generic: { discovery_chars: 999 } }).success, false)
  assert.equal(catalog({ recipe: { input_tokens: 64, output_tokens: 64 } }).success, true)
  assert.equal(catalog({ recipe: { output_tokens: 63 } }).success, false)
  assert.equal(catalog({ recipe: { factors: { glossary: false, vocabulary: false } } }).success, false)
})

test('canonical settings: full Article, no nulls, the unused ceiling restored, empty Catalog members dropped', () => {
  const parsed = extractionSettingsSchema.parse({
    article: { context: 'full', context_tokens: 16384, grounding_schedule: null, selection: null },
    catalog: { generic: {}, recipe: { factors: { verification: false } } },
  })
  assert.deepEqual(extractionSettingsIssues(parsed), [])
  const canonical = canonicalExtractionSettings(parsed)
  assert.deepEqual(canonical, {
    article: { ...REFERENCE_ARTICLE, context_tokens: ARTICLE_REFERENCE_CONTEXT_TOKENS },
    catalog: { recipe: { factors: { glossary: true, headings: true, overlap: true, verification: false } } },
  })
  assert.deepEqual(Object.keys(canonical.article!), ['context', 'context_tokens', 'overlap_passages', 'identity', 'identity_fields', 'prompt', 'grounding'])
  assert.deepEqual(canonicalExtractionSettings(extractionSettingsSchema.parse({ catalog: {} })), {})
  // An explicit Article is never an omission: it changes the service's artifact.
  assert.deepEqual(canonicalExtractionSettings(extractionSettingsSchema.parse({ article: {} })), { article: REFERENCE_ARTICLE })
})

test('canonical Catalog settings keep schema key order, whatever order equal settings arrive in', () => {
  const serialized = (catalog: Record<string, unknown>) => JSON.stringify(canonicalExtractionSettings(catalog as ExtractionSettings))
  const inOrder = {
    generic: { discovery_chars: 30000, record_chars: 20000 },
    recipe: { input_tokens: 2048, output_tokens: 512, factors: { glossary: true, headings: false, overlap: true, verification: false } },
  }
  const reordered = {
    recipe: { factors: { verification: false, overlap: true, headings: false, glossary: true }, output_tokens: 512, input_tokens: 2048 },
    generic: { record_chars: 20000, discovery_chars: 30000 },
  }
  assert.equal(serialized({ catalog: reordered }), serialized({ catalog: inOrder }))
  assert.equal(JSON.stringify(canonicalExtractionSettings(extractionSettingsSchema.parse({ catalog: reordered }))), serialized({ catalog: inOrder }))
  const intent = (settings: Record<string, unknown>, recipe: string | null) =>
    JSON.stringify(canonicalIntent({ models: null, settings }, 'CATALOG', recipe))
  assert.equal(intent({ generic: reordered.generic }, null), intent({ generic: inOrder.generic }, null))
  assert.equal(intent({ recipe: reordered.recipe }, 'numbered-catalogue-de@1'), intent({ recipe: inOrder.recipe }, 'numbered-catalogue-de@1'))
  const wire = (settings: ActiveSettings, recipe: string | null) =>
    JSON.stringify(keiMethodOptions(extractionMethod('CATALOG', recipe, null, settings)))
  assert.equal(wire({ generic: reordered.generic }, null), wire({ generic: inOrder.generic }, null))
  assert.equal(wire({ recipe: reordered.recipe }, 'numbered-catalogue-de@1'), wire({ recipe: inOrder.recipe }, 'numbered-catalogue-de@1'))
})

const EXPLORE: ArticleSettings = {
  context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
  prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
}

test('the exact wire example: strategy, models and every active option, nothing invented', () => {
  const method = extractionMethod('ARTICLE', null, { fields: 'instruct', reasoning: 'instruct' }, { article: EXPLORE })
  assert.deepEqual(keiMethodOptions(method), {
    strategy: 'article',
    models: { fields: 'instruct', reasoning: 'instruct' },
    article: {
      context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
    },
  })
})

test('service defaults omit the strategy member; generic Catalog emits no catalog object; inactive settings never leak', () => {
  assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, null, { article: null })), { strategy: 'article' })
  assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, null, null)), { strategy: 'article' })
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, null, { generic: { record_chars: 30000 } })),
    { strategy: 'catalog', record_chars: 30000 })
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', 'numbered-catalogue-de@1', null, { recipe: REFERENCE_CATALOG.recipe! })),
    { strategy: 'catalog', catalog: { recipe: 'numbered-catalogue-de@1', ...REFERENCE_CATALOG.recipe } })
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', 'numbered-catalogue-de@1', null, { recipe: null })),
    { strategy: 'catalog', catalog: { recipe: 'numbered-catalogue-de@1' } })
  const saved = extractionSettingsSchema.parse({ article: EXPLORE, catalog: REFERENCE_CATALOG })
  assert.deepEqual(activeSettings(saved, 'CATALOG', null), { generic: REFERENCE_CATALOG.generic })
  assert.deepEqual(activeSettings(saved, 'ARTICLE', null), { article: EXPLORE })
  for (const strategy of ['ARTICLE', 'CATALOG'] as const) {
    const wire = JSON.stringify(keiMethodOptions(extractionMethod(strategy, null, null, activeSettings(saved, strategy, null))))
    for (const invented of ['"plain"', '"all"', '"token"', '"source_order"', 'null']) assert.ok(!wire.includes(invented), wire)
  }
})

test('explicit reference and omission are different descriptors', () => {
  const omitted = activeMethod(null, {}, 'ARTICLE', null)
  const explicit = activeMethod(null, { article: REFERENCE_ARTICLE }, 'ARTICLE', null)
  assert.deepEqual(omitted, { models: null, settings: { article: null } })
  assert.notDeepEqual(omitted, explicit)
  assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, null, explicit.settings)).article, REFERENCE_ARTICLE)
})

test('an account document yields the active descriptor; only the chosen strategy counts', () => {
  const document = {
    connections: [], routes: {}, ingestionModels: {},
    extractionModels: { fields: 'nuextract' },
    extractionSettings: { article: EXPLORE, catalog: { generic: { record_chars: 30000 } } },
  }
  assert.deepEqual(accountMethod(document, 'ARTICLE', null), { models: { fields: 'nuextract' }, settings: { article: EXPLORE } })
  assert.deepEqual(accountMethod(document, 'CATALOG', 'numbered-catalogue-de@1'), { models: { fields: 'nuextract' }, settings: { recipe: null } })
  assert.deepEqual(accountMethod(null, 'CATALOG', null), { models: null, settings: { generic: null } })
  assert.throws(() => accountMethod({ extractionModels: {}, extractionSettings: { article: { overlap_passages: 1 } } }, 'ARTICLE', null),
    (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_model_config')
})

test('a submitted intent is canonicalized, and one for another strategy is refused', () => {
  assert.deepEqual(canonicalIntent({ models: {}, settings: { article: { ...EXPLORE, grouping: null } } }, 'ARTICLE', null),
    { models: null, settings: { article: EXPLORE } })
  assert.deepEqual(canonicalIntent({ models: null, settings: { generic: {} } }, 'CATALOG', null), { models: null, settings: { generic: null } })
  assert.equal(canonicalIntent({ models: null, settings: { article: null } }, 'CATALOG', null), null)
  assert.equal(canonicalIntent({ models: null, settings: { article: { overlap_passages: 1 } } }, 'ARTICLE', null), null)
  assert.equal(canonicalIntent({ models: null, settings: { generic: null }, preset: 'best' }, 'CATALOG', null), null)
})

test('a stored snapshot is read back, and one for another strategy is an invalid method', () => {
  assert.equal(storedSettings(null, 'ARTICLE', null), null)
  assert.deepEqual(storedSettings({ article: EXPLORE }, 'ARTICLE', null), { article: EXPLORE })
  assert.throws(() => storedSettings({ generic: null }, 'ARTICLE', null),
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

test('where the deployment enables it, a new Catalog Extraction uses the unified method, never a recipe', () => {
  assert.equal(unifiedCatalogEnabled({}), false)
  assert.equal(unifiedCatalogEnabled({ FREE_CATALOG_METHOD: 'unified' }), true)
  const saved: ExtractionSettings = { catalog: { unified: { overlap: 0, verification: false } } }
  // The latest defaults version is always pinned, so a method left wholly to the defaults stays identifiable.
  assert.deepEqual(activeMethod(null, {}, 'CATALOG', null, true), { models: null, settings: { unified: { defaults: 2 } } })
  const method = activeMethod({ fields: 'nuextract' }, saved, 'CATALOG', 'numbered-catalogue-de@1', true)
  assert.deepEqual(method.settings, { unified: { defaults: 2, overlap: 0, verification: false } })
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, method.models, method.settings)), {
    strategy: 'catalog', models: { fields: 'nuextract' }, unified: { defaults: 2, overlap: 0, verification: false },
  })
  // Article and the legacy slots are untouched by the unified preference.
  assert.deepEqual(activeSettings(saved, 'CATALOG', null), { generic: null })
  assert.deepEqual(activeSettings(saved, 'ARTICLE', null, true), { article: null })
  // A submitted unified intent is canonical; a unified method never carries a recipe.
  assert.deepEqual(canonicalIntent({ models: null, settings: { unified: { verification: false, defaults: 1 } } }, 'CATALOG', null),
    { models: null, settings: { unified: { defaults: 1, verification: false } } })
  assert.deepEqual(canonicalIntent({ models: null, settings: { unified: { defaults: 2 } } }, 'CATALOG', null),
    { models: null, settings: { unified: { defaults: 2 } } })
  assert.equal(canonicalIntent({ models: null, settings: { unified: { defaults: 1 } } }, 'CATALOG', 'numbered-catalogue-de@1'), null)
  assert.equal(canonicalIntent({ models: null, settings: { unified: { defaults: 1 } } }, 'ARTICLE', null), null)
  // An Extraction keeps the defaults version it was admitted under.
  assert.deepEqual(storedSettings({ unified: { defaults: 1 } }, 'CATALOG', null), { unified: { defaults: 1 } })
  assert.throws(() => storedSettings({ unified: { defaults: 1 } }, 'CATALOG', 'numbered-catalogue-de@1'), ExtractionError)
})

test('legacy Catalog preferences refuse new unified Catalog admission until migrated, and keep Article usable', () => {
  const account = (catalog: unknown) => ({ extractionModels: {}, extractionSettings: { catalog } })
  for (const legacy of [{ generic: { record_chars: 30_000 } }, { recipe: { factors: { glossary: false } } }])
    assert.throws(() => accountMethod(account(legacy), 'CATALOG', null, true),
      (error: unknown) => error instanceof ExtractionError && error.code === 'catalog_migration_required')
  const legacy = account({ generic: { record_chars: 30_000 } })
  assert.deepEqual(accountMethod(legacy, 'ARTICLE', null, true), { models: null, settings: { article: null } })
  // Without the deployment's switch the legacy method is unchanged, character limits and all.
  assert.deepEqual(accountMethod(legacy, 'CATALOG', null), { models: null, settings: { generic: { record_chars: 30_000 } } })
  // Applying the unified group replaces the Catalog branch: nothing legacy is left to migrate.
  const applied = canonicalExtractionSettings({ catalog: { unified: { overlap: 2 } } })
  assert.deepEqual(accountMethod(account(applied.catalog), 'CATALOG', null, true).settings, { unified: { defaults: 2, overlap: 2 } })
  assert.deepEqual(canonicalExtractionSettings({ catalog: { unified: {} } }), {})
  assert.equal(extractionSettingsSchema.safeParse({ catalog: { unified: { input_tokens: 100 } } }).success, false)
})
