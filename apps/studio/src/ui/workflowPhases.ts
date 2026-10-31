/** The guided workflow's six steps, in order, and their researcher-facing labels.
 *  Shared by the compact `PhaseProgress` strip and the full step list
 *  (ProjectContextPage's ProjectWorkflowSteps), so both name the same
 *  sequence. Kept beside the component rather than inside it: a module that
 *  exports a component may not also export constants (react-refresh). */
export type WorkflowPhase =
  | 'upload'
  | 'schema'
  | 'pilot'
  | 'approve'
  | 'batch'
  | 'review'

export type PhaseProgressTone = 'progress' | 'running' | 'validated' | 'stale'

export const phaseOrder: readonly WorkflowPhase[] = [
  'upload',
  'schema',
  'pilot',
  'approve',
  'batch',
  'review',
]

export const phaseLabels: Record<WorkflowPhase, string> = {
  upload: 'Upload',
  schema: 'Create schema',
  pilot: 'Pilot',
  approve: 'Approve',
  batch: 'Batch extract',
  review: 'Review',
}
