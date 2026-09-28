import type { ExtractionModelChoice, ExtractionStrategy } from './types.js'

const ROLES = ['fields', 'reasoning'] as const

type ExtractionMethod = Readonly<{
  strategy: ExtractionStrategy
  catalogRecipe: string | null
  requestedModels: ExtractionModelChoice | null
}>

/** A choice from a request or stored jsonb value: absent, null and empty roles all mean service defaults. */
export function modelChoice(value: unknown): ExtractionModelChoice | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const chosen: { fields?: string; reasoning?: string } = {}
  for (const role of ROLES) {
    const key = (value as Record<string, unknown>)[role]
    if (typeof key === 'string' && key !== '') chosen[role] = key
  }
  return Object.keys(chosen).length === 0 ? null : chosen
}

/** The method persisted on an Extraction: a recipe applies only to Catalog, and unchosen roles use service defaults. */
export function extractionMethod(
  strategy: ExtractionStrategy,
  catalogRecipe: string | null | undefined,
  requestedModels: unknown,
): ExtractionMethod {
  return {
    strategy,
    catalogRecipe: strategy === 'CATALOG' ? catalogRecipe ?? null : null,
    requestedModels: modelChoice(requestedModels),
  }
}

/** The Parsing Service's options for the same pinned method. */
export function keiMethodOptions(method: ExtractionMethod): Record<string, unknown> {
  return {
    strategy: method.strategy === 'CATALOG' ? 'catalog' : 'article',
    ...(method.requestedModels === null ? {} : { models: method.requestedModels }),
    ...(method.catalogRecipe === null ? {} : { catalog: { recipe: method.catalogRecipe } }),
  }
}
