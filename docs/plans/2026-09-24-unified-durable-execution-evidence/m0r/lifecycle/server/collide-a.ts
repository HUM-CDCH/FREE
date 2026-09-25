import { DBOS } from '@dbos-inc/dbos-sdk'

// Same JavaScript function name as collide-b.ts. Registered WITHOUT a name, so
// DBOS falls back to `func.name`, which a bundler may rename on collision.
async function job(): Promise<string> {
  return 'a'
}
export const unnamedJob = DBOS.registerWorkflow(job)
