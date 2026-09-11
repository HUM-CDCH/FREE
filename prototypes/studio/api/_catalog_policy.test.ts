import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readCatalogPolicy, writeCatalogPolicy } from './_catalog_policy.js'

it('persists runtime overrides, retains the previous snapshot, and rejects invalid saves', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'free-policy-'))
  const options = { configRoot }
  vi.stubEnv('FREE_CATALOG_POLICY', '{"recordBatchSize":2}')
  try {
    const running = await readCatalogPolicy(options)
    expect(running.recordBatchSize).toBe(2)
    await writeCatalogPolicy({ ...running, recordBatchSize: 8, citations: true, citationLinks: true }, options)
    expect((await readCatalogPolicy(options)).recordBatchSize).toBe(8)
    expect(running.recordBatchSize).toBe(2)
    for (const invalid of [null, { recordBatchSize: 0 }, { citations: 'yes' }, { unknown: true }]) {
      await expect(writeCatalogPolicy(invalid, options)).rejects.toMatchObject({ status: 400 })
    }
    expect((await readCatalogPolicy(options)).citations).toBe(true)
    await expect(writeCatalogPolicy({ citations: false }, {
      configRoot, fileSystem: { ...(await import('./_model_config.js')).nodeFileSystem, rename: async () => { throw new Error('disk failure') } },
    })).rejects.toMatchObject({ status: 500 })
    expect((await readCatalogPolicy(options)).citations).toBe(true)
  } finally {
    vi.unstubAllEnvs()
    await rm(configRoot, { recursive: true, force: true })
  }
})
