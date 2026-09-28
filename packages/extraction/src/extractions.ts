import type { ExtractionExecution } from './dependencies.js'
import { createExtractionModule } from './module.js'
import { createResearcherExtractionPersistence } from './postgres-persistence.js'
import type { ExtractionModule } from './types.js'

/** One researcher's Extractions, admitted and read through `execution`. */
export function createExtractions(researcherAccountId: string, execution: ExtractionExecution): ExtractionModule {
  return createExtractionModule(createResearcherExtractionPersistence(researcherAccountId, execution))
}
