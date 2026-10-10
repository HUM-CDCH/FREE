import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { planTwoMigrations } from './migration-snapshots-fixture.js'
import { LAST_COPIED_START, migrationDirectories, shareStartContracts, startContractCopies } from './migration-snapshots.js'

const packageRoot = resolve(import.meta.dirname, '..')
const committed = resolve(packageRoot, 'migrations/app')
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

/** The contract file a migration's `migration.ts` imports as `startContract` or `endContract`, resolved. */
function imported(root: string, directory: string, binding: 'startContract' | 'endContract') {
  const source = readFileSync(join(root, directory, 'migration.ts'), 'utf8')
  const specifier = source.match(new RegExp(`^import ${binding} from '([^']+)'`, 'm'))?.[1]
  return specifier && resolve(root, directory, specifier)
}

/** Every migration's bookend imports name the contracts its manifest records, so `migration.ts` recompiles to it. */
function assertBookends(root: string) {
  for (const directory of migrationDirectories(root)) {
    const { from, to } = read(join(root, directory, 'migration.json'))
    const start = imported(root, directory, 'startContract'), end = imported(root, directory, 'endContract')
    assert.equal(end && read(end).storage.storageHash, to, `${directory} imports another end contract`)
    assert.equal(start && read(start).storage.storageHash, from ?? undefined, `${directory} imports another start contract`)
  }
}

test('committed migrations import contracts matching their manifests and keep no shareable start-contract copy', () => {
  assertBookends(committed)
  assert.deepEqual(startContractCopies(committed), [], 'Plan migrations with `pnpm --filter db db:migration plan ' +
    '--name <slug>`, or run `pnpm --filter db db:migration` to share these start contracts.')
})

test('sequentially planned migrations store each contract once, and still recompile, check and type-check', () => {
  const scratch = planTwoMigrations()
  after(scratch.remove)
  const { migrations, first, second } = scratch
  assert.equal(second.from, first.to)

  // Each start contract is the predecessor's end contract, imported where it already is.
  for (const { directory } of [first, second])
    for (const file of ['start-contract.json', 'start-contract.d.ts'])
      assert.equal(existsSync(join(migrations, directory, file)), false, `${directory} kept ${file}`)
  assert.equal(basename(imported(migrations, first.directory, 'startContract') ?? ''), 'end-contract.json')
  assert.equal(imported(migrations, second.directory, 'startContract'), join(migrations, first.directory, 'end-contract.json'))
  assertBookends(migrations)
  const holding = (hash: string) => migrationDirectories(migrations).flatMap((directory) =>
    readdirSync(join(migrations, directory)).filter((file) => file.endsWith('-contract.json'))
      .filter((file) => read(join(migrations, directory, file)).storage.storageHash === hash)
      .map((file) => `${directory}/${file}`))
  assert.deepEqual(holding(first.to), [`${first.directory}/end-contract.json`])
  // History keeps its copies; sharing is idempotent.
  assert.equal(existsSync(join(migrations, LAST_COPIED_START, 'start-contract.json')), true)
  assert.deepEqual(shareStartContracts(migrations), [])

  // Planning straight through prisma-next leaves a copy the committed-tree check reports until it is shared.
  const third = scratch.plan('snapshotProbeC', 'snapshot_probe_c', true)
  assert.deepEqual(startContractCopies(migrations), [[third.directory, second.directory]])
  // Read-only subcommands preserve pending files and pass paths as literal arguments to the pinned CLI.
  const config = join(scratch.packageDirectory, 'config with spaces & symbols.ts')
  copyFileSync(join(scratch.packageDirectory, 'prisma-next.config.ts'), config)
  assert.equal(JSON.parse(scratch.run(join(packageRoot, 'node_modules/.bin/tsx'),
    [join(packageRoot, 'src/migration-command.ts'), 'check', '--json', '--config', config])).ok, true)
  assert.deepEqual(startContractCopies(migrations), [[third.directory, second.directory]])
  assert.deepEqual(shareStartContracts(migrations), [third.directory])
  assert.deepEqual(startContractCopies(migrations), [])

  // Recompiling the authored migration reproduces the planned operations and identity byte for byte.
  for (const { directory } of [first, second]) {
    const planned = ['ops.json', 'migration.json'].map((file) => readFileSync(join(migrations, directory, file)))
    scratch.run(process.execPath, [join(migrations, directory, 'migration.ts')])
    assert.deepEqual(['ops.json', 'migration.json'].map((file) => readFileSync(join(migrations, directory, file))), planned)
  }
  assert.equal(JSON.parse(scratch.run(join(packageRoot, 'node_modules/.bin/prisma-next'), ['migration', 'check', '--json'])).ok, true)
  // The shared type imports resolve: Node strips `import type` when recompiling, so only tsc sees them.
  scratch.run(join(packageRoot, 'node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2024', '--module', 'preserve', '--moduleResolution', 'bundler', '--resolveJsonModule', '--types', 'node',
    ...[first, second].map(({ directory }) => join(migrations, directory, 'migration.ts'))])
})
