import { describe, expect, it, vi } from 'vitest'
import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import { readEvaluationRounds } from './evaluationRounds.js'

vi.mock('../auth/authenticatedFetch.ts', () => ({ authenticatedFetch: vi.fn() }))

const round = {
  evaluationRoundId: '51000000-0000-4000-8012-000000000001',
  projectSpreadsheetVersionId: '51000000-0000-4000-8010-000000000001',
  pipelineRunId: '51000000-0000-4000-8011-000000000001',
  label: 'PILOT_1',
  status: 'SUCCEEDED',
  documents: [],
  pins: null,
  metrics: { micro: { f1: 1 } },
  failure: null,
  createdAt: '2026-10-06T10:00:00.000Z',
  completedAt: '2026-10-06T10:00:00.000Z',
}

describe('readEvaluationRounds', () => {
  it('returns null when the deployment does not expose the surface', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(null, { status: 404 }))
    expect(await readEvaluationRounds('51000000-0000-4000-8000-000000000001')).toBeNull()
  })

  it('parses the rounds a Project Context returned', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      Response.json({ evaluationRounds: [round] }),
    )
    const rounds = await readEvaluationRounds('51000000-0000-4000-8000-000000000001')
    expect(rounds).toHaveLength(1)
    expect(rounds?.[0]?.label).toBe('PILOT_1')
    expect(vi.mocked(authenticatedFetch).mock.calls[0]?.[0]).toContain(
      'projectContextId=51000000-0000-4000-8000-000000000001',
    )
  })
})
