import type { ActiveSettings } from 'extraction/extraction-method'
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
  const recipe = settings.recipe
  if (!recipe) return []
  const off = recipe.factors ? FACTORS.filter((factor) => !recipe.factors![factor]).map((factor) => CATALOG_LABELS[factor].toLowerCase()) : []
  return [
    { label: CATALOG_LABELS.input_tokens, value: amount(recipe.input_tokens, 'tokens') },
    { label: CATALOG_LABELS.output_tokens, value: amount(recipe.output_tokens, 'tokens') },
    { label: 'Factors', value: off.length === 0 ? 'All factors on' : `Off: ${off.join(', ')}` },
  ]
}

export function settingsHeadline(settings: ActiveSettings | null): string {
  if (settings === null) return 'Not recorded'
  if ('article' in settings) return settings.article ? effectiveSummary(settings.article) : 'Service defaults'
  const lines = methodLines(settings)
  return lines.length === 0 ? 'Service defaults' : lines.map((line) => (line.label === 'Factors' ? line.value : `${line.label} ${line.value}`)).join(' · ')
}

export function modelsLine(models: ExtractionModelChoice | null): string {
  return `Field values: ${models?.fields ?? 'deployment default'} · Reasoning: ${models?.reasoning ?? 'deployment default'}`
}
