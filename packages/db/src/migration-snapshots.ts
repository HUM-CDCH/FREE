/**
 * Prisma Next 0.16 writes every migration's start contract as a copy of its predecessor's end contract. The
 * tooling reads only `end-contract.*` (the runner's contract row, planning, `migration check`, refs); the start copy
 * is read only by the migration's own `migration.ts`. Sharing points that import at the predecessor's end contract,
 * so a new migration reuses that state without another start copy. The upstream `migrations/snapshots/<hash>`
 * store needs 0.17, which rewrites every `migrationHash` and contract hash.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

/** Migrations up to this one were planned with start-contract copies, and keep them unchanged. */
export const LAST_COPIED_START = '20261006T0837_iterative_evaluation_rounds'

export function migrationDirectories(root: string): string[] {
  return readdirSync(root).filter((name) => existsSync(join(root, name, 'migration.json'))).sort()
}

/** Whether `start` (in `directory`) holds the contract `other`'s end contract holds: equal JSON, identical types. */
export function sameContract(root: string, directory: string, start: string, other: string): boolean {
  const read = (name: string, file: string) => readFileSync(join(root, name, file))
  if (!existsSync(join(root, other, 'end-contract.json')) || !existsSync(join(root, other, 'end-contract.d.ts')))
    return false
  // Planning from a ref writes the start contract as canonical one-line JSON, so compare values rather than bytes.
  return isDeepStrictEqual(JSON.parse(read(directory, `${start}.json`).toString()), JSON.parse(read(other, 'end-contract.json').toString()))
    && read(directory, `${start}.d.ts`).equals(read(other, 'end-contract.d.ts'))
}

/** Each later migration whose start contract copies a migration's end contract, with the earliest such migration. */
export function startContractCopies(root: string): Array<[directory: string, predecessor: string]> {
  const directories = migrationDirectories(root)
  return directories
    .filter((directory) => directory > LAST_COPIED_START && existsSync(join(root, directory, 'start-contract.json')))
    .flatMap((directory) => {
      const predecessor = directories.find((other) => other !== directory && sameContract(root, directory, 'start-contract', other))
      return predecessor ? [[directory, predecessor] as [string, string]] : []
    })
}

/**
 * Replaces each start-contract copy with an import of that predecessor's end contract, then deletes the copy. A start
 * contract no end contract matches (planned from a ref whose contract no migration reached) is the only copy and
 * stays. Returns the migrations it changed.
 */
export function shareStartContracts(root: string): string[] {
  const copies = startContractCopies(root)
  for (const [directory, predecessor] of copies) {
    const file = join(root, directory, 'migration.ts')
    const source = readFileSync(file, 'utf8')
    const imports = [`'./start-contract'`, `'./start-contract.json'`]
    if (!imports.every((specifier) => source.includes(`from ${specifier}`)))
      throw new Error(`${file} no longer imports the generated start contract; restore its imports or share it by hand.`)
    writeFileSync(file, source
      .replace(`from './start-contract'`, `from '../${predecessor}/end-contract'`)
      .replace(`from './start-contract.json'`, `from '../${predecessor}/end-contract.json'`))
    for (const copy of ['start-contract.json', 'start-contract.d.ts']) rmSync(join(root, directory, copy))
  }
  return copies.map(([directory]) => directory)
}
