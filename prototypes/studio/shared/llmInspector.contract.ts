export type LlmTraceStatus = 'running' | 'complete' | 'failed' | 'cancelled'

export type LlmTrace = {
  readonly id: string
  readonly operation: string
  readonly provider: string
  readonly model: string
  readonly profile: string
  readonly startedAt: string
  completedAt: string | null
  status: LlmTraceStatus
  request: string
  response: string | null
}
