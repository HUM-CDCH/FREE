import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The Studio PostgreSQL tier (vitest.postgres.config.ts) runs these.
    exclude: [...configDefaults.exclude, 'e2e/**', '**/*.postgres.test.ts'],
  },
})
