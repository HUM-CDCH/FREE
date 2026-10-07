import { configDefaults, defineConfig } from 'vitest/config'

// DBOS is one singleton per process: each file runs alone, in its own fork, with its own system schemas.
export default defineConfig({
  test: {
    include: ['**/*.postgres.test.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
