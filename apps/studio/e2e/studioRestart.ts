import { readPlaywrightLifecycleStateForTest } from './playwrightStack.js'
import { e2eStudioPath, E2E_ORIGIN } from './auth.js'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Kills the running Studio (Vite's whole process group, as a crash would) and waits for the restartable wrapper's
 * respawn: a new Vite PID in the lifecycle state within 30 s, then Studio answering `/auth/signed-out` within 60 s.
 * Only the recovery config runs a restartable stack (FREE_PLAYWRIGHT_RESTARTABLE=1).
 */
export async function killStudio(): Promise<{ oldPid: number; newPid: number }> {
  const before = await readPlaywrightLifecycleStateForTest()
  if (before.vitePid === undefined) throw new Error('The Playwright stack has no running Vite to kill.')
  process.kill(-before.vitePid, 'SIGKILL')

  const respawnDeadline = Date.now() + 30_000
  let newPid: number | undefined
  while (Date.now() < respawnDeadline) {
    const state = await readPlaywrightLifecycleStateForTest().catch(() => undefined)
    if (state?.vitePid !== undefined && state.vitePid !== before.vitePid) {
      newPid = state.vitePid
      break
    }
    await delay(200)
  }
  if (newPid === undefined) throw new Error('The Playwright wrapper did not respawn Vite within 30 s.')

  const readyDeadline = Date.now() + 60_000
  while (Date.now() < readyDeadline) {
    const answered = await fetch(`${E2E_ORIGIN}${e2eStudioPath('/auth/signed-out')}`, { redirect: 'manual' })
      .then((response) => response.status === 200)
      .catch(() => false)
    if (answered) return { oldPid: before.vitePid, newPid }
    await delay(250)
  }
  throw new Error('The respawned Studio did not answer within 60 s.')
}
