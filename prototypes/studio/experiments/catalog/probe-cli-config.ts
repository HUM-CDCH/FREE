/** Minimal real requests to reproduce the observed CLI feature-type failure. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { createCodexAppServer } from 'ai-sdk-provider-codex-cli'
import { createRestrictedCodexProvider } from '../../api/_provider.js'

const results = []
const probes: Record<string, Record<string, boolean | string>>[] = [
  {},
  { 'features.context_management': { experimental_mode: true } },
  { 'features.multi_agent_v2': { hide_spawn_agent_metadata: false, tool_namespace: 'agents' } },
]
for (const featureOverrides of probes) {
  const cwd = await mkdtemp(join(tmpdir(), 'free-cli-config-probe-'))
  const provider = createRestrictedCodexProvider(cwd, options => createCodexAppServer({
    ...options,
    defaultSettings: { ...options?.defaultSettings, configOverrides: {
      ...options?.defaultSettings?.configOverrides,
      ...featureOverrides,
    } },
  }))
  try {
    const response = await generateText({ model: provider('gpt-5.6-luna'), prompt: 'Return only the JSON object {"ok":true}.', abortSignal: AbortSignal.timeout(20000) })
    results.push({ featureOverrides, outcome: 'succeeded', text: response.text })
  } catch (error) {
    results.push({ featureOverrides, outcome: 'failed', error: error instanceof Error ? error.message : String(error) })
  } finally {
    await provider.close()
    await rm(cwd, { recursive: true, force: true })
  }
  console.log(JSON.stringify(results.at(-1)))
}
await writeFile('../../artifacts/catalog-lab/beier/cli-config-probe.json', JSON.stringify(results, null, 2))
