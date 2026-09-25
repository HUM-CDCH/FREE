import { DBOS } from '@dbos-inc/dbos-sdk'

// Same JavaScript function name as collide-a.ts, registered WITH a name.
async function job(): Promise<string> {
  return 'b'
}
export const namedJob = DBOS.registerWorkflow(job, { name: 'namedJob' })
