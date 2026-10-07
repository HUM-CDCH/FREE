import { UNIFIED_CATALOG_DEFAULTS, type ActiveSettings, type UnifiedCatalogSettings } from 'extraction/extraction-method'
import type { ExtractionModelChoice } from '../shared/extraction.contract'
import {
  ARTICLE_SECTIONS, CATALOG_LABELS, CONTROL_LABELS, describeArticleValue, effectiveSummary,
} from './providerConfig/advancedSettings'

/** How a start view and "Method used" describe a method: one headline, and a line per setting. Words only. */
export type MethodLine = Readonly<{ label: string; value: string }>

const amount = (value: number | undefined, unit: string) => (value === undefined ? 'service default' : `${value.toLocaleString('en-US')} ${unit}`)
const FACTORS = ['glossary', 'headings', 'overlap', 'verification'] as const

export function methodLines(settings: ActiveSettings | null): readonly MethodLine[] {
  if (settings === null) return []
  if ('article' in settings) {
    const article = settings.article
    if (!article) return []
    return ARTICLE_SECTIONS.flatMap(({ keys }) => keys)
      .filter((key) => !(key === 'context_tokens' && article.context === 'full'))
      .map((key) => ({ label: CONTROL_LABELS[key], value: describeArticleValue(article, key) }))
  }
  if ('generic' in settings) {
    const generic = settings.generic
    return generic ? [
      { label: CATALOG_LABELS.discovery_chars, value: amount(generic.discovery_chars, 'characters') },
      { label: CATALOG_LABELS.record_chars, value: amount(generic.record_chars, 'characters') },
    ] : []
  }
  if ('unified' in settings) return unifiedLines(settings.unified)
  const recipe = settings.recipe
  if (!recipe) return []
  const off = recipe.factors ? FACTORS.filter((factor) => !recipe.factors![factor]).map((factor) => CATALOG_LABELS[factor].toLowerCase()) : []
  return [
    { label: CATALOG_LABELS.input_tokens, value: amount(recipe.input_tokens, 'tokens') },
    { label: CATALOG_LABELS.output_tokens, value: amount(recipe.output_tokens, 'tokens') },
    { label: 'Factors', value: off.length === 0 ? 'All factors on' : `Off: ${off.join(', ')}` },
  ]
}

/** The unified Catalog's five controls, each as requested: a value left to the defaults says so. */
export function unifiedLines(unified: UnifiedCatalogSettings): readonly MethodLine[] {
  const defaults = UNIFIED_CATALOG_DEFAULTS[unified.defaults]
  const onOff = (value: boolean | undefined, fallback: boolean) =>
    value === undefined ? `service default (${fallback ? 'on' : 'off'})` : value ? 'On' : 'Off'
  return [
    { label: UNIFIED_LABELS.input_tokens, value: unified.input_tokens === undefined ? 'Auto (served context minus the reply reserve)' : amount(unified.input_tokens, 'tokens') },
    { label: UNIFIED_LABELS.output_tokens, value: unified.output_tokens === undefined ? 'service defaults per stage' : amount(unified.output_tokens, 'tokens') },
    { label: UNIFIED_LABELS.overlap, value: unified.overlap === undefined ? `service default (${defaults.overlap} source line)` : `${unified.overlap} source line${unified.overlap === 1 ? '' : 's'}` },
    { label: UNIFIED_LABELS.headings, value: onOff(unified.headings, defaults.headings) },
    { label: UNIFIED_LABELS.verification, value: onOff(unified.verification, defaults.verification) },
  ]
}

export const UNIFIED_LABELS = {
  input_tokens: 'Input token ceiling', output_tokens: 'Reply token reserve', overlap: 'Window overlap',
  headings: 'Heading context', verification: 'Verification',
} as const

export function settingsHeadline(settings: ActiveSettings | null): string {
  if (settings === null) return 'Not recorded'
  if ('unified' in settings) {
    const custom = Object.keys(settings.unified).length > 1
    return `Unified Catalog, defaults version ${settings.unified.defaults}${custom ? ' with custom settings' : ''}`
  }
  if ('article' in settings) return settings.article ? effectiveSummary(settings.article) : 'Service defaults'
  const lines = methodLines(settings)
  return lines.length === 0 ? 'Service defaults' : lines.map((line) => (line.label === 'Factors' ? line.value : `${line.label} ${line.value}`)).join(' · ')
}

export function modelsLine(models: ExtractionModelChoice | null): string {
  return `Field values: ${models?.fields ?? 'deployment default'} · Reasoning: ${models?.reasoning ?? 'deployment default'}`
}
