import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createModelConfigurationStore, db, pool } from 'db'
import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
import { applyAccountModelConfig, readAccountModelConfig, EMPTY_MODEL_CONFIG } from './_model_config.js'
import { createModelKeyCache } from './_model_keys.js'
import { disposableDatabaseUrl } from '../test/support/postgres.js'

disposableDatabaseUrl()
const accounts: string[] = []
afterAll(async () => {
  try { for (const id of accounts) await db.orm.public.ResearcherAccount.where({ id }).delete() }
  finally { await db.close(); await pool.end() }
})

describe('advanced settings in PostgreSQL', () => {
  it('an Apply survives a reload, and a refused Apply leaves the saved document as it was', async () => {
    const account = await db.orm.public.ResearcherAccount.create({ tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Advanced' })
    accounts.push(account.id)
    const store = createModelConfigurationStore(db)
    const keys = createModelKeyCache()
    const saved = { ...EMPTY_MODEL_CONFIG, extractionSettings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans' as const } } }
    await applyAccountModelConfig({ config: saved }, { researcherAccountId: account.id, store, keys })
    await expect(readAccountModelConfig(account.id, store)).resolves.toEqual(saved)
    const refused = { ...saved, extractionSettings: { article: { ...REFERENCE_ARTICLE, overlap_passages: 1 } } }
    await expect(applyAccountModelConfig({ config: refused }, { researcherAccountId: account.id, store, keys }))
      .rejects.toMatchObject({ status: 409, code: 'invalid_model_config' })
    await expect(readAccountModelConfig(account.id, store)).resolves.toEqual(saved)
  })
})
