// M0R item 2(a), workspace case: Studio imports `db` (a linked pnpm workspace
// package), and Vite bundles that package's own dependencies (Studio's current
// bundle inlines pg and Prisma Next). What happens if DBOS is imported from a
// linked workspace package, with and without Studio declaring it?
//
// Layout (pnpm-like): app/node_modules/m0r-linked -> ../../linked;
// linked/node_modules/@dbos-inc/dbos-sdk -> the real install. The app resolves
// DBOS only if app/node_modules/@dbos-inc/dbos-sdk exists ("declared").
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const realInstall = process.env.M0R_NODE_MODULES // dir holding @dbos-inc, vite, pg
if (!realInstall) throw new Error('Set M0R_NODE_MODULES to the throwaway node_modules')
const vite = join(realInstall, '.bin/vite')
const roots = []
const out = (event, data) => console.log(`RESULT ${event} ${JSON.stringify(data)}`)

function layout(declared) {
  // Outside any directory whose node_modules could resolve DBOS by accident.
  const root = mkdtempSync(join(tmpdir(), 'free-m0r-ws-'))
  roots.push(root)
  rmSync(root, { recursive: true, force: true })
  const app = join(root, 'app')
  const linked = join(root, 'linked')
  mkdirSync(join(app, 'server'), { recursive: true })
  mkdirSync(join(app, 'node_modules'), { recursive: true })
  mkdirSync(join(linked, 'node_modules/@dbos-inc'), { recursive: true })
  writeFileSync(join(linked, 'package.json'), JSON.stringify({ name: 'm0r-linked', type: 'module', exports: { '.': './index.ts' } }))
  writeFileSync(
    join(linked, 'index.ts'),
    "import { DBOS } from '@dbos-inc/dbos-sdk'\nexport const isLaunched = () => DBOS.isInitialized()\n",
  )
  symlinkSync(join(realInstall, '@dbos-inc/dbos-sdk'), join(linked, 'node_modules/@dbos-inc/dbos-sdk'))
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'm0r-app', type: 'module' }))
  symlinkSync(linked, join(app, 'node_modules/m0r-linked'))
  // vite itself must resolve from the config's directory
  symlinkSync(join(realInstall, 'vite'), join(app, 'node_modules/vite'))
  if (declared) {
    mkdirSync(join(app, 'node_modules/@dbos-inc'), { recursive: true })
    symlinkSync(join(realInstall, '@dbos-inc/dbos-sdk'), join(app, 'node_modules/@dbos-inc/dbos-sdk'))
  }
  writeFileSync(
    join(app, 'server/index.ts'),
    "import { isLaunched } from 'm0r-linked'\nconsole.log('M0R ' + JSON.stringify({ event: 'ran', launched: isLaunched() }))\n",
  )
  cpSync(join(here, 'vite.server.config.ts'), join(app, 'vite.server.config.ts'))
  return app
}

for (const declared of [false, true]) {
  for (const explicitExternal of [false, true]) {
    const app = layout(declared)
    const args = ['build', '--config', 'vite.server.config.ts']
    const env = { ...process.env, M0R_EXPLICIT_EXTERNAL: explicitExternal ? '1' : '' }
    const b = spawnSync(vite, args, { cwd: app, env, encoding: 'utf8' })
    const buildText = `${b.stdout}\n${b.stderr}`
    const result = {
      declaredInApp: declared,
      explicitExternal,
      build: b.status === 0 ? 'ok' : buildText.match(/Error: \[vite\]: ([^\n]+)/)?.[1] ?? 'failed',
    }
    if (b.status === 0) {
      const bundle = spawnSync('cat', ['dist/server/index.js'], { cwd: app, encoding: 'utf8' }).stdout
      result.dbosImportedExternally = /from "@dbos-inc\/dbos-sdk"/.test(bundle)
      result.bundleBytes = bundle.length
      const r = spawnSync('node', ['dist/server/index.js'], { cwd: app, encoding: 'utf8' })
      result.run = r.status === 0 ? r.stdout.trim() : (r.stderr.match(/(Error[^\n]*|Cannot find[^\n]*)/)?.[0] ?? `exit ${r.status}`)
    }
    out('workspace-case', result)
  }
}
for (const root of roots) rmSync(root, { recursive: true, force: true })
