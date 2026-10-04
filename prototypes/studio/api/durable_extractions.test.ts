import type { ResearcherProjectStore } from 'db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDurableRepository, DurableNotFound } from 'extraction/durable'
import { createResearcherApiHandlers } from './durable_extractions'

vi.mock('extraction/durable', async importOriginal => ({
  ...await importOriginal<typeof import('extraction/durable')>(),
  createDurableRepository: vi.fn(),
}))
vi.mock('../server/durable-extraction-workflow.js', () => ({requestDurableReconciliation:vi.fn()}))
afterEach(()=>vi.clearAllMocks())
const id='00000000-0000-4000-8000-000000000001'
const request=()=>new Request(`https://localhost/api/extractions/${id}/durable`)
const store={researcherAccountId:'owner'} as ResearcherProjectStore

describe('durable extraction reads require an owned runtime head',()=> {
  it('returns 404 when no owned durable Extraction exists',async()=> {
    vi.mocked(createDurableRepository).mockReturnValue({read:vi.fn().mockRejectedValue(new DurableNotFound('That Extraction was not found.'))} as never)
    const response=await createResearcherApiHandlers(store).GET(request())
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({error:{code:'not_found'}})
  })
  it('keeps a missing coordination schema unavailable',async()=> {
    vi.mocked(createDurableRepository).mockReturnValue({read:vi.fn().mockRejectedValue(Object.assign(new Error('Unavailable'),{code:'42P01'}))} as never)
    const response=await createResearcherApiHandlers(store).GET(request())
    expect(response.status).toBe(503)
    expect(await response.json()).not.toHaveProperty('protocol')
  })
})
