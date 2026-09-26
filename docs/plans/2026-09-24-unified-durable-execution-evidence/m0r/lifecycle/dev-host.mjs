// Development-style host: loads the server through Vite's SSR module loader,
// the way Studio's `vite` dev server loads /server/app.ts (vite.config.ts).
import { createServer } from 'vite'
import { DBOS } from '@dbos-inc/dbos-sdk'

const root = import.meta.dirname
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
})
const say = (event, data = {}) => console.log(`M0R ${JSON.stringify({ event, ...data })}`)

const entry = await vite.ssrLoadModule('/server/index.ts')
await entry.main()
// If Vite externalized @dbos-inc/dbos-sdk, the SSR-loaded server and this
// natively imported module share one DBOS singleton.
say('dev-singleton', { nativeImportSeesLaunch: DBOS.isInitialized() })

if (process.env.M0R_DEV_RELOAD === '1') {
  // What Studio's development host does after a server-file edit today:
  // invalidate the SSR module graph and load the composition root again.
  vite.moduleGraph.invalidateAll()
  try {
    await vite.ssrLoadModule('/server/workflows.ts')
    say('dev-reload', { outcome: 'module re-evaluated without error' })
  } catch (error) {
    say('dev-reload', {
      outcome: `threw ${error.constructor.name}`,
      message: String(error.message).split('\n')[0],
    })
  }
  await DBOS.shutdown()
  await vite.close()
  process.exit(0)
}
