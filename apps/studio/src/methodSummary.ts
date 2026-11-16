import {
  canonicalArticle, REFERENCE_ARTICLE, UNIFIED_CATALOG_DEFAULTS, type ActiveSettings, type UnifiedCatalogSettings,
} from 'extraction/extraction-method'
import type { ExtractionModelChoice } from '../shared/extraction.contract'
import {
  ARTICLE_SECTIONS, CONTROL_LABELS, describeArticleValue, effectiveSummary,
} from './providerConfig/advancedSettings'

/** How a start view and "Method used" describe a method: one headline, and a line per setting. Words only. */
export type MethodLine = Readonly<{ label: string; value: string }>

const amount = (value: number | undefined, unit: string) => (value === undefined ? 'service default' : `${value.toLocaleString('en-US')} ${unit}`)

export function methodLines(settings: ActiveSettings): readonly MethodLine[] {
  if ('article' in settings) {
    const article = settings.article
    if (!article) return []
    return ARTICLE_SECTIONS.flatMap(({ keys }) => keys)
      .filter((key) => !(key === 'context_tokens' && article.context === 'full'))
      .map((key) => ({ label: CONTROL_LABELS[key], value: describeArticleValue(article, key) }))
  }
  return unifiedLines(settings.unified)
}

/** The unified Catalog's five controls, each as requested: a value left to the defaults says so. */
export function unifiedLines(unified: UnifiedCatalogSettings): readonly MethodLine[] {
  const defaults = UNIFIED_CATALOG_DEFAULTS[unified.defaults]
  const onOff = (value: boolean | undefined, fallback: boolean) =>
    value === undefined ? `service default (${fallback ? 'on' : 'off'})` : value ? 'On' : 'Off'
  return [
    { label: UNIFIED_LABELS.input_tokens, value: unified.input_tokens === undefined ? 'Auto (served context minus the reply reserve)' : amount(unified.input_tokens, 'tokens') },
    { label: UNIFIED_LABELS.output_tokens, value: unified.output_tokens === undefined ? 'service defaults per stage; an entry reply may use the rest of the context (not with a native fields model)' : amount(unified.output_tokens, 'tokens') },
    { label: UNIFIED_LABELS.overlap, value: unified.overlap === undefined ? `service default (${defaults.overlap} source line)` : `${unified.overlap} source line${unified.overlap === 1 ? '' : 's'}` },
    { label: UNIFIED_LABELS.headings, value: onOff(unified.headings, defaults.headings) },
    { label: UNIFIED_LABELS.candidates, value: unified.candidates === undefined ? `service default (${32} excerpts)` : `${unified.candidates} excerpt${unified.candidates === 1 ? '' : 's'}` },
  ]
}

export const UNIFIED_LABELS = {
  input_tokens: 'Input token ceiling', output_tokens: 'Reply token reserve', overlap: 'Window overlap',
  headings: 'Heading context', candidates: 'Heading excerpts measured',
} as const

export function settingsHeadline(settings: ActiveSettings): string {
  if ('unified' in settings) {
    const custom = Object.keys(settings.unified).length > 1
    return `Unified Catalog, defaults version ${settings.unified.defaults}${custom ? ' with custom settings' : ''}`
  }
  if ('article' in settings) {  // recorded without settings: the whole source, the service defaults of its time
    const defaults = JSON.stringify(canonicalArticle(settings.article)) === JSON.stringify(canonicalArticle(REFERENCE_ARTICLE))
    return `${defaults ? 'Service defaults · ' : ''}${effectiveSummary(settings.article)}`
  }
  const lines = methodLines(settings)
  return lines.length === 0 ? 'Service defaults' : lines.map((line) => (line.label === 'Factors' ? line.value : `${line.label} ${line.value}`)).join(' · ')
}

export function modelsLine(models: ExtractionModelChoice | null): string {
  return `Field values: ${models?.fields ?? 'deployment default'} · Reasoning: ${models?.reasoning ?? 'deployment default'}`
}
