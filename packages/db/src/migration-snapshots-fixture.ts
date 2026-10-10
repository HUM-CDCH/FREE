/**
 * A temporary copy of this package's contract and migration history, planned forward by two migrations the way FREE
 * plans them: change the contract, emit it, `pnpm --filter db db:migration plan`, then advance the committed `db` ref
 * to the new head. Nothing under `packages/db` is written.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { migrationDirectories } from './migration-snapshots.js'

const packageRoot = resolve(import.meta.dirname, '..')
const bin = (name: string) => join(packageRoot, 'node_modules/.bin', name)

export type PlannedMigration = Readonly<{ directory: string; from: string; to: string }>

export function planTwoMigrations() {
  const packageDirectory = mkdtempSync(join(tmpdir(), 'free-migration-snapshots-'))
  // Binaries run by path: pnpm run here would reinstall this package's dependencies through the link.
  symlinkSync(join(packageRoot, 'node_modules'), join(packageDirectory, 'node_modules'), 'junction')
  for (const path of ['prisma-next.config.ts', 'src/prisma/contract.prisma', 'migrations'])
    cpSync(join(packageRoot, path), join(packageDirectory, path), { recursive: true })
  const migrations = join(packageDirectory, 'migrations/app')
  // Emitting and planning read the contract only; this connection string is never dialled. The wrapper runs prisma-next
  // from PATH, as a package script would.
  const env = { ...process.env, PATH: `${bin('')}${delimiter}${process.env.PATH}`, DATABASE_URL: 'postgresql://contract:emit@127.0.0.1:5432/free' }
  const run = (file: string, args: string[]) =>
    execFileSync(file, args, { cwd: packageDirectory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const contract = join(packageDirectory, 'src/prisma/contract.prisma')
  /** Plans `column` through `pnpm --filter db db:migration plan`, or straight through prisma-next when `raw`. */
  const plan = (column: string, name: string, raw = false): PlannedMigration => {
    writeFileSync(contract, readFileSync(contract, 'utf8').replace('model EvaluationRound {\n', `model EvaluationRound {\n  ${column} String?\n`))
    run(bin('prisma-next'), ['contract', 'emit', '--no-color'])
    const before = new Set(migrationDirectories(migrations))
    const args = ['plan', '--name', name, '--no-color']
    if (raw) run(bin('prisma-next'), ['migration', ...args])
    else run(bin('tsx'), [join(packageRoot, 'src/migration-command.ts'), ...args])
    const directory = migrationDirectories(migrations).find((name) => !before.has(name))
    if (!directory) throw new Error(`Planning ${column} wrote no migration.`)
    const { from, to } = JSON.parse(readFileSync(join(migrations, directory, 'migration.json'), 'utf8'))
    run(bin('prisma-next'), ['ref', 'set', 'db', to, '--no-color'])
    return { directory, from, to }
  }
  const remove = () => rmSync(packageDirectory, { recursive: true, force: true })
  try {
    const first = plan('snapshotProbeA', 'snapshot_probe_a')
    const second = plan('snapshotProbeB', 'snapshot_probe_b')
    return { packageDirectory, migrations, first, second, plan, run, remove }
  } catch (error) {
    remove()
    throw error
  }
}
