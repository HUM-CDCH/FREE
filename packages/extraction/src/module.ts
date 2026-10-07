import type { ExtractionPersistence } from './dependencies.js'
import { ExtractionError } from './errors.js'
import type { ExtractionModule, RunSingleInput } from './types.js'

const DEFAULT_LIMIT = 50

/** Admission and reads of durable Extractions. Review, control and exports go through the durable repository. */
export function createExtractionModule(persistence: ExtractionPersistence): ExtractionModule {
  const runSingle = async (input: RunSingleInput) => {
    const result = await persistence.scheduleExtraction(input)
    if (!result) throw new ExtractionError('not_found', 'That Extraction was not found.')
    return result
  }

  return {
    runSingle,
    readExtractionAttempt: (extractionId) => persistence.readExtractionAttempt(extractionId),
    readDocumentExtractions: (input) =>
      persistence.readDocumentExtractions(input),
    async scheduleBatch(input) {
      const result = await persistence.scheduleBatch(input)
      if (!result) throw new ExtractionError('not_found', 'That Project Context was not found.')
      return result
    },
    async scheduleSuggestedBatch(input) {
      const result = await persistence.scheduleSuggestedBatch(input)
      if (!result) throw new ExtractionError('not_found', 'That Schema Suggestion was not found.')
      return result
    },
    async stabiliseSchemaRevision(input) {
      const result = await persistence.stabiliseSchemaRevision(input)
      if (result === 'not-found')
        throw new ExtractionError('not_found', 'That Schema Revision was not found.')
      if (result === 'not-ready')
        throw new ExtractionError(
          'schema_not_ready_to_stabilise',
          'Review at least one pilot Extraction against this Schema Revision before stabilising it.',
        )
      return result
    },
    async listBatches({ projectContextId, limit = DEFAULT_LIMIT }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ExtractionError('invalid_request', 'The Batch Extraction limit must be between 1 and 100.')
      const batches = await persistence.listBatches(projectContextId, limit)
      if (!batches) throw new ExtractionError('not_found', 'That Project Context was not found.')
      return batches
    },
    async readBatch(input) {
      const batch = await persistence.readBatch(input)
      if (!batch) throw new ExtractionError('not_found', 'That Batch Extraction was not found.')
      return batch
    },
  }
}
