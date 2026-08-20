import {
  canonicalPackageStore,
  db,
  type CanonicalPackageStore,
  type Database,
} from 'db'
import type { ExtractionModuleDependencies } from './dependencies.js'
import { createExtractionModule } from './module.js'
import { BatchExtractionWorker } from './batch-worker.js'
import { PostgresExtractionPersistence } from './postgres-persistence.js'
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
  const persistence = new PostgresExtractionPersistence(
    infrastructure.database,
    infrastructure.packages,
  )
  const module = createExtractionModule({ ...dependencies, persistence })
  const worker = new BatchExtractionWorker(persistence, module)

  const wakeAfter = <T>(operation: () => Promise<T>): Promise<T> =>
    operation().then((result) => {
      worker.wake()
      return result
    })

  const extractions: ExtractionModule = {
    ...module,
    scheduleBatch: (input) => wakeAfter(() => module.scheduleBatch(input)),
    scheduleSuggestedBatch: (input) => wakeAfter(() => module.scheduleSuggestedBatch(input)),
  }

  return {
    extractions,
    run: (signal) => worker.run(signal),
    close: () => worker.close(),
  }
}
