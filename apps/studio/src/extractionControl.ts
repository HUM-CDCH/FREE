import type { DurableReading } from './durableReader'
import { resultSchemaLabel } from './resultSchema'

export const PAUSE_DESCRIPTION = 'Pause after the calls in flight; their work is saved'

/** What continuing (Resume, Retry) the latest Extraction waits for, if anything, and what it continues with. */
export function continuation(state: DurableReading['state'] | undefined): { blocked: string | null; description: string } {
  const active = state?.schemaRevisions?.find((revision) => revision.schemaRevisionId === state.selection.schemaRevisionId)
  const pending = state?.schemaRevisions?.find((revision) => revision.schemaRevisionId === state.pendingSelection?.schemaRevisionId)
  if (state?.pendingSelection) {
    const blocked = `Apply or discard the pending inputs${pending ? ` (${resultSchemaLabel(pending)})` : ''} before continuing.`
    return { blocked, description: blocked }
  }
  return {
    blocked: null,
    description: active
      ? `Continue this extraction with ${resultSchemaLabel(active)}. Changes to the current template do not change its saved inputs.`
      : 'Continue this extraction with its saved inputs.',
  }
}
