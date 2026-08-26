import {
  canonicalPackageStore,
  db,
  type CanonicalPackageStore,
  type Database,
} from 'db'
import type { ExtractionModuleDependencies } from './dependencies.js'
import {
  createExtractionModule,
  ExtractionOperationRegistry,
} from './module.js'
import { BatchExtractionWorker } from './batch-worker.js'
import {
  createClaimedBatchExtractionPersistence,
  createInternalBatchExtractionWorkerStore,
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
  const operations = new ExtractionOperationRegistry()
  const workerStore = createInternalBatchExtractionWorkerStore(
    infrastructure.database,
    infrastructure.packages,
  )
  const worker = new BatchExtractionWorker(workerStore, (batch) =>
    createExtractionModule(
      {
        ...dependencies,
        persistence: createClaimedBatchExtractionPersistence(
          batch.batchExtractionId,
          batch.lease,
          infrastructure.database,
          infrastructure.packages,
        ),
      },
      {
        operations,
        operationScope: `batch:${batch.batchExtractionId}:${batch.lease.owner}:${batch.lease.version}`,
      },
    ),
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
        {
          operations,
          operationScope: `researcher:${researcherAccountId}`,
        },
      )
      const extractions: ExtractionModule = {
        ...module,
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
