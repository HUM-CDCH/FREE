import { spawnSync } from 'node:child_process'

const windows = process.platform === 'win32'
const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'prisma-next'
const args = windows ? ['/d', '/s', '/c', 'prisma-next db verify'] : ['db', 'verify']
const result = spawnSync(command, args, { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) {
  console.error(
    '\nThe development database does not match this branch. If its data is disposable, run `pnpm db:reset`, restart with `pnpm start`, then run `pnpm db:seed`.',
  )
  process.exitCode = result.status ?? 1
}
