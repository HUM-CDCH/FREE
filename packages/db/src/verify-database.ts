import { spawnSync } from 'node:child_process'

const command = process.platform === 'win32' ? 'prisma-next.cmd' : 'prisma-next'
const result = spawnSync(command, ['db', 'verify'], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) {
  console.error(
    '\nThe development database does not match this branch. If its data is disposable, run `pnpm db:reset`, restart with `pnpm start`, then run `pnpm db:seed`.',
  )
  process.exitCode = result.status ?? 1
}
