import {
  canonicalPackageStore,
  db,
  type CanonicalPackageStore,
  type Database,
} from 'db'
import type { ExtractionModuleDependencies } from './dependencies.js'
import { createExtractionModule } from './module.js'
import { ExtractionJobWorker } from './job-worker.js'
import {
  createInternalExtractionJobStore,
  createInternalExtractionPersistence,
  createResearcherExtractionPersistence,
} from './postgres-persistence.js'
import type { ExtractionModule, ExtractionRuntime } from './types.js'

export type CreateExtractionRuntimeDependencies = Readonly<
  Pick<ExtractionModuleDependencies, 'models' | 'now'>
>

export function createExtractionRuntime(
  dependencies: CreateExtractionRuntimeDependencies,
): ExtractionRuntime {
  return createExtractionRuntimeWithInfrastructure(dependencies, {
    database: db,
    packages: canonicalPackageStore,
  })
}

/** Package-private construction seam for Postgres integration tests. */
export function createExtractionRuntimeWithInfrastructure(
  dependencies: CreateExtractionRuntimeDependencies,
  infrastructure: Readonly<{
    database: Database
    packages: CanonicalPackageStore
  }>,
): ExtractionRuntime {
  const workerStore = createInternalExtractionJobStore(
    infrastructure.database,
    infrastructure.packages,
  )
  const workerExtractions = createExtractionModule({
    ...dependencies,
    persistence: createInternalExtractionPersistence(
      infrastructure.database,
      infrastructure.packages,
    ),
  })
  const worker = new ExtractionJobWorker(
    workerStore,
    workerExtractions.executeJob,
  )

  const wakeAfter = <T>(operation: () => Promise<T>): Promise<T> =>
    operation().then((result) => {
      worker.wake()
      return result
    })

  return {
    forResearcher(researcherAccountId) {
      const module = createExtractionModule(
        {
          ...dependencies,
          persistence: createResearcherExtractionPersistence(
            researcherAccountId,
            infrastructure.database,
            infrastructure.packages,
          ),
        },
      )
      const extractions: ExtractionModule = {
        ...module,
        runSingle: (input) => wakeAfter(() => module.runSingle(input)),
        async cancelSingle(extractionId) {
          const outcome = await module.cancelSingle(extractionId)
          if (outcome === 'cancellation-requested')
            setTimeout(() => worker.abort(extractionId), 1_000)
          return outcome
        },
        scheduleBatch: (input) =>
          wakeAfter(() => module.scheduleBatch(input)),
        scheduleSuggestedBatch: (input) =>
          wakeAfter(() => module.scheduleSuggestedBatch(input)),
      }
      return extractions
    },
    run: (signal) => worker.run(signal),
    close: () => worker.close(),
  }
}
