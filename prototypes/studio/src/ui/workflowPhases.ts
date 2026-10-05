/** The workflow's five phases, in order, and their researcher-facing labels.
 *  Shared by the compact `PhaseProgress` strip and the full step list
 *  (ProjectContextPage's ProjectWorkflowSteps), so both name the same
 *  sequence. Kept beside the component rather than inside it: a module that
 *  exports a component may not also export constants (react-refresh). */
export type WorkflowPhase =
  | 'ingest'
  | 'chat'
  | 'approve'
  | 'extract'
  | 'validate'

export type PhaseProgressTone = 'progress' | 'running' | 'validated' | 'stale'

export const phaseOrder: readonly WorkflowPhase[] = [
  'ingest',
  'chat',
  'approve',
  'extract',
  'validate',
]

export const phaseLabels: Record<WorkflowPhase, string> = {
  ingest: 'Upload',
  chat: 'Create schema',
  approve: 'Approve schema',
  extract: 'Extract',
  validate: 'Validate',
}
