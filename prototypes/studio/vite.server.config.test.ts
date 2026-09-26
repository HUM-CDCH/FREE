import { expect, it } from 'vitest'

it('the server bundle keeps the DBOS packages external', async () => {
  const { default: config } = await import('./vite.server.config.js')

  expect(config.ssr?.external).toEqual([
    '@dbos-inc/dbos-sdk',
    '@dbos-inc/vercel-ai',
  ])
})
