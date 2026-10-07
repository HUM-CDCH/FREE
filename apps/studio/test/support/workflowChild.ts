import { existsSync, writeFileSync } from 'node:fs'

const name = process.argv[2]
if (!name || !/^[a-z-]+$/.test(name)) throw new Error('Name a scenario in test/support/scenarios/.')
const marker = process.env.FREE_CRASH_MARKER
if (!marker) throw new Error('FREE_CRASH_MARKER must name a file the first run creates.')
const firstRun = !existsSync(marker)
if (firstRun) writeFileSync(marker, 'first run\n')
const scenario = (await import(`./scenarios/${name}.ts`)) as {
  run(context: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void>
}
await scenario.run({ firstRun, env: process.env })
process.exit(0)
