import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationRoundRecord, ResearcherProjectStore } from 'db'
import { createResearcherApiHandlers } from './evaluation_rounds.js'

const researcherAccountId = '51000000-0000-4000-8009-000000000001'
const projectContextId = '51000000-0000-4000-8000-000000000001'
const now = new Date('2026-10-06T10:00:00.000Z')

function handlerFor(store: Partial<ResearcherProjectStore>) {
  return createResearcherApiHandlers({
    researcherAccountId,
    ...store,
  } as ResearcherProjectStore)
}

function request(projectContextIdValue: string | null = projectContextId) {
  const query = projectContextIdValue === null ? '' : `?projectContextId=${projectContextIdValue}`
  return new Request(`http://test/api/evaluation-rounds${query}`)
}

function round(overrides: Partial<EvaluationRoundRecord> = {}): EvaluationRoundRecord {
  return {
    evaluationRoundId: '51000000-0000-4000-8012-000000000001',
    projectContextId,
    projectSpreadsheetVersionId: '51000000-0000-4000-8010-000000000001',
    pipelineRunId: '51000000-0000-4000-8011-000000000001',
    label: 'PILOT_1',
    status: 'SUCCEEDED',
    documents: [{ sourceDocumentId: '51000000-0000-4000-8001-000000000001', filename: 'a.pdf' }],
    pins: { goldSha256: 'sha256:gold' },
    metrics: { micro: { f1: 1 } },
    failure: null,
    createdAt: now,
    completedAt: now,
    ...overrides,
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/evaluation-rounds', () => {
  it('does not exist when the developer switch is off', async () => {
    vi.stubEnv('FREE_DEVELOPER_EVAL', '')
    const listEvaluationRounds = vi.fn()
    const response = await handlerFor({ listEvaluationRounds }).GET(request())
    expect(response.status).toBe(404)
    expect(listEvaluationRounds).not.toHaveBeenCalled()
  })

  it("returns the owner's rounds", async () => {
    vi.stubEnv('FREE_DEVELOPER_EVAL', '1')
    const listEvaluationRounds = vi.fn(async () => [round()])
    const response = await handlerFor({ listEvaluationRounds }).GET(request())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.evaluationRounds).toHaveLength(1)
    expect(body.evaluationRounds[0].label).toBe('PILOT_1')
    expect(body.evaluationRounds[0].metrics).toEqual({ micro: { f1: 1 } })
    expect(body.evaluationRounds[0].createdAt).toBe(now.toISOString())
    expect(listEvaluationRounds).toHaveBeenCalledWith(projectContextId, 50)
  })

  it('404s a Project Context the account does not own', async () => {
    vi.stubEnv('FREE_DEVELOPER_EVAL', '1')
    const response = await handlerFor({ listEvaluationRounds: vi.fn(async () => null) }).GET(request())
    expect(response.status).toBe(404)
  })

  it('rejects a missing or invalid projectContextId', async () => {
    vi.stubEnv('FREE_DEVELOPER_EVAL', '1')
    const handler = handlerFor({})
    expect((await handler.GET(request(null))).status).toBe(422)
    expect((await handler.GET(request('not-a-uuid'))).status).toBe(422)
  })
})
