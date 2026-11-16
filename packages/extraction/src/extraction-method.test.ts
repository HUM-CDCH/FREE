import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  accountMethod, activeMethod, activeSettings, articleSettingsSchema, canonicalArticle, canonicalExtractionSettings,
  canonicalIntent, canonicalUnified, extractionMethod, extractionSettingsIssues, extractionSettingsSchema,
  keiMethodOptions, legacyCatalogOverrides, METHOD_MESSAGES, REFERENCE_ARTICLE, REFERENCE_CATALOG,
  type ExtractionSettings, storedSettings, unifiedCatalogEnabled, unifiedCatalogSettingsSchema, UNIFIED_CATALOG_DEFAULTS,
  UNIFIED_CATALOG_DEFAULTS_VERSION, UNIFIED_CATALOG_PRO_VERSION, validateArticleOptions,
} from './extraction-method.js'
import { gliformerIssues } from './gliformer-compatibility.js'
import { ExtractionError } from './errors.js'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../apps/parsing_service/tests/fixtures/contracts/${name}.json`, import.meta.url), 'utf8'))

test('Article settings match the service cases and every live categorical combination', () => {
  const shared = fixture('article-options')
  for (const item of shared.cases) {
    const result = validateArticleOptions(item.input)
    assert.equal(result.ok, item.accepted, item.id)
    if (result.ok) assert.deepEqual(canonicalArticle(result.value), item.canonical, item.id)
  }
  const factors = Object.entries(shared.inventory.factors) as [string, unknown[]][]
  const inputs = factors.reduce<Record<string, unknown>[]>((rows, [key, choices]) =>
    rows.flatMap(row => choices.map(value => value === null ? row : { ...row, [key]: value })), [{}])
  assert.equal(inputs.length, shared.inventory.verdicts.length)
  inputs.forEach((input, index) => assert.equal(validateArticleOptions({ ...input, context_tokens: shared.inventory.context_tokens }).ok,
    shared.inventory.verdicts[index] === '1', JSON.stringify(input)))
})

test('Article constraints still name the control that refuses an invalid choice', () => {
  for (const [input, path, message] of [
    [{ overlap_passages: 1 }, 'overlap_passages', METHOD_MESSAGES.bounded],
    [{ grouping: 'structural' }, 'grouping', METHOD_MESSAGES.bounded],
    [{ evidence_policy: 'schema' }, 'evidence_policy', METHOD_MESSAGES.schemaPolicy],
    [{ grounding: 'off', grounding_overflow: 'windows' }, 'grounding_overflow', METHOD_MESSAGES.overflow],
  ] as const) {
    const result = validateArticleOptions(input)
    assert.ok(!result.ok && result.issues.some(issue => issue.path === path && issue.message === message))
  }
  assert.equal(validateArticleOptions({ context: 'bounded', context_tokens: 8192 }).ok, true)
  for (const context_tokens of [8191, 8192.5, '12288'])
    assert.equal(validateArticleOptions({ context: 'bounded', context_tokens }).ok, false)
})

test('Article admissions always record and send explicit settings', () => {
  const method = activeMethod(null, {}, 'ARTICLE', null)
  assert.deepEqual(method.settings, { article: REFERENCE_ARTICLE })
  assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, null, method.settings)), {
    strategy: 'article', article: REFERENCE_ARTICLE,
  })
  const explicit = articleSettingsSchema.parse({ context_tokens: 16384 })
  const canonical = canonicalExtractionSettings(extractionSettingsSchema.parse({ article: explicit, catalog: { generic: {} } }))
  assert.deepEqual(canonical, { article: canonicalArticle(explicit) })
  assert.deepEqual(extractionSettingsIssues(canonical), [])
  assert.deepEqual(Object.keys(canonical.article!), ['context', 'context_tokens', 'overlap_passages', 'grounding'])
  assert.deepEqual(accountMethod({ extractionModels: {}, extractionSettings: {} }, 'ARTICLE', null), method)
})

test('Catalog settings keep their own slot and canonical key order', () => {
  const settings = extractionSettingsSchema.parse({ article: REFERENCE_ARTICLE, catalog: REFERENCE_CATALOG })
  assert.deepEqual(activeSettings(settings, 'ARTICLE', null), { article: REFERENCE_ARTICLE })
  assert.deepEqual(activeSettings(settings, 'CATALOG', null), { generic: REFERENCE_CATALOG.generic })
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, null, { generic: { record_chars: 30000 } })),
    { strategy: 'catalog', record_chars: 30000 })
  assert.equal(canonicalIntent({ models: null, settings: { generic: null } }, 'ARTICLE', null), null)
  assert.throws(() => storedSettings({ generic: null }, 'ARTICLE', null), /invalid/i)
})

test('retired methods are refused instead of replayed or shown as not recorded', () => {
  for (const defaults of [1, 2, 3, 4, 6, 7, 8, 9]) {
    assert.equal(canonicalIntent({ models: null, settings: { unified: { defaults } } }, 'CATALOG', null), null)
    assert.throws(() => storedSettings({ unified: { defaults } }, 'CATALOG', null), /invalid/i)
  }
  assert.equal(canonicalIntent({ models: null, settings: { article: null } }, 'ARTICLE', null), null)
  assert.throws(() => storedSettings(null, 'ARTICLE', null), /invalid/i)
  assert.throws(() => storedSettings({ article: null }, 'ARTICLE', null), /invalid/i)
  for (const key of ['identity', 'identity_fields', 'prompt', 'selection', 'grounding_schedule', 'grounding_routing'])
    assert.equal(validateArticleOptions({ [key]: null }).ok, false, key)
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
  assert.deepEqual(activeMethod(null, {}, 'CATALOG', null, true), { models: null, settings: { unified: { defaults: 10 } } })
  const method = activeMethod({ fields: 'nuextract' }, saved, 'CATALOG', 'numbered-catalogue-de@1', true)
  assert.deepEqual(method.settings, { unified: { defaults: 10, overlap: 0, verification: false } })
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, method.models, method.settings)), {
    strategy: 'catalog', models: { fields: 'nuextract' }, unified: { defaults: 10, overlap: 0, verification: false },
  })
  // Article and the legacy slots are untouched by the unified preference.
  assert.deepEqual(activeSettings(saved, 'CATALOG', null), { generic: null })
  assert.deepEqual(activeSettings(saved, 'ARTICLE', null, true), { article: REFERENCE_ARTICLE })
  // A submitted unified intent is canonical; a unified method never carries a recipe.
  assert.deepEqual(canonicalIntent({ models: null, settings: { unified: { verification: false, defaults: 5 } } }, 'CATALOG', null),
    { models: null, settings: { unified: { defaults: 5, verification: false } } })
  assert.deepEqual(canonicalIntent({ models: null, settings: { unified: { defaults: 5 } } }, 'CATALOG', null),
    { models: null, settings: { unified: { defaults: 5 } } })
  assert.equal(canonicalIntent({ models: null, settings: { unified: { defaults: 5 } } }, 'CATALOG', 'numbered-catalogue-de@1'), null)
  assert.equal(canonicalIntent({ models: null, settings: { unified: { defaults: 5 } } }, 'ARTICLE', null), null)
  // An Extraction keeps the defaults version it was admitted under.
  assert.deepEqual(storedSettings({ unified: { defaults: 5 } }, 'CATALOG', null), { unified: { defaults: 5 } })
  assert.throws(() => storedSettings({ unified: { defaults: 5 } }, 'CATALOG', 'numbered-catalogue-de@1'), ExtractionError)
})

test('legacy Catalog preferences refuse new unified Catalog admission until migrated, and keep Article usable', () => {
  const account = (catalog: unknown) => ({ extractionModels: {}, extractionSettings: { catalog } })
  for (const legacy of [{ generic: { record_chars: 30_000 } }, { recipe: { factors: { glossary: false } } }])
    assert.throws(() => accountMethod(account(legacy), 'CATALOG', null, true),
      (error: unknown) => error instanceof ExtractionError && error.code === 'catalog_migration_required')
  const legacy = account({ generic: { record_chars: 30_000 } })
  assert.deepEqual(accountMethod(legacy, 'ARTICLE', null, true), { models: null, settings: { article: REFERENCE_ARTICLE } })
  // Without the deployment's switch the legacy method is unchanged, character limits and all.
  assert.deepEqual(accountMethod(legacy, 'CATALOG', null), { models: null, settings: { generic: { record_chars: 30_000 } } })
  // Applying the unified group replaces the Catalog branch: nothing legacy is left to migrate.
  const applied = canonicalExtractionSettings({ catalog: { unified: { overlap: 2 } } })
  assert.deepEqual(accountMethod(account(applied.catalog), 'CATALOG', null, true).settings, { unified: { defaults: 10, overlap: 2 } })
  // Pro mode: the account's verification on admits the version whose verification call reads every value again.
  const pro = accountMethod(account({ unified: { verification: true, overlap: 0 } }), 'CATALOG', null, true).settings
  assert.deepEqual(pro, { unified: { defaults: UNIFIED_CATALOG_PRO_VERSION, overlap: 0, verification: true } })
  // A native fields model cannot verify, so its admission still refuses Pro mode.
  assert.ok(gliformerIssues({ models: { fields: 'gliformer' }, settings: pro }, []).includes('verification must be Auto or off'))
  assert.deepEqual(accountMethod(account({ unified: { verification: false } }), 'CATALOG', null, true).settings,
    { unified: { defaults: 10, verification: false } })
  // A method that names its version keeps its own verification.
  assert.deepEqual(canonicalIntent({ models: null, settings: { unified: { defaults: 10, verification: true } } }, 'CATALOG', null),
    { models: null, settings: { unified: { defaults: 10, verification: true } } })
  assert.deepEqual(canonicalExtractionSettings({ catalog: { unified: {} } }), {})
  assert.equal(extractionSettingsSchema.safeParse({ catalog: { unified: { input_tokens: 100 } } }).success, false)
})


test('heading candidate overrides survive saved settings and pinned defaults 7 methods', () => {
  const settings: ExtractionSettings = { catalog: { unified: { candidates: 8, headings: true } } }
  assert.deepEqual(canonicalExtractionSettings(settings), settings)
  const pinned = { unified: { defaults: 10 as const, candidates: 8, headings: true } }
  assert.deepEqual(storedSettings(pinned, 'CATALOG', null), pinned)
  assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, null, pinned)), {
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
