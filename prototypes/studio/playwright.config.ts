import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: 'http://localhost:41739' },
  webServer: {
    command: 'pnpm dev --port 41739',
    url: 'http://localhost:41739',
    reuseExistingServer: false,
  },
})
