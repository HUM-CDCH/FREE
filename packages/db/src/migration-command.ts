import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { shareStartContracts } from './migration-snapshots.js'

// `prisma-next migration plan|new` copies the predecessor's end contract into each new migration; share it instead.
// Without arguments this only shares the copies already on disk.
const args = process.argv.slice(2)
if (args.length) {
  const cli = createRequire(import.meta.url).resolve('prisma-next/dist/cli.js')
  const result = spawnSync(process.execPath, [cli, 'migration', ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// prisma-next resolves its config, and so the migrations, from the working directory.
if (!args.length || args[0] === 'plan' || args[0] === 'new')
  for (const directory of shareStartContracts(resolve('migrations/app')))
    console.log(`${directory} imports its start contract from its predecessor's end contract.`)
