/** Every Studio workflow's explicit name. A bundler renames unnamed functions (M0R 2: `job$1`), and a workflow started
 *  under one build must be recoverable by another. */
export const STUDIO_WORKFLOW_NAMES: readonly string[] = []

let registered = false

/** Registers every Studio workflow. Only launchStudioDbos calls it, once, before DBOS.launch(); no module registers a
 *  workflow at import, because the API dispatcher and several tests import every handler module. */
export function registerStudioWorkflows(): void {
  if (registered) return
  registered = true
}
