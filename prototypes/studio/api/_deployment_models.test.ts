import { describe, expect, it } from 'vitest'
import { DEPLOYMENT_CONNECTION_IDS } from '../shared/modelConfig.contract.js'
import { DEPLOYMENT_IDS, deploymentModels } from './_deployment_models.js'

const codex = {
  id: DEPLOYMENT_CONNECTION_IDS.codexCli, name: 'Codex CLI on this server', provider: 'codex-cli', baseUrl: null, hasKey: false,
}
const claude = {
  id: DEPLOYMENT_CONNECTION_IDS.claudeCode, name: 'Claude Code on this server', provider: 'claude-code', baseUrl: null, hasKey: false,
}

describe('deploymentModels', () => {
  it('FREE_DEPLOYMENT_CLI_PROVIDERS enables each CLI kind as a read-only deployment connection', () => {
    const listed = (value: string | undefined) => deploymentModels({ FREE_DEPLOYMENT_CLI_PROVIDERS: value }).connections

    expect(listed('codex-cli,claude-code')).toEqual([codex, claude])
    expect(listed(' claude-code ')).toEqual([claude])
    expect(listed('codex-cli,unknown')).toEqual([codex])
    expect(listed(undefined)).toEqual([])
    expect(deploymentModels({ FREE_DEPLOYMENT_CLI_PROVIDERS: 'codex-cli' }).defaultRoute).toBeNull()
    expect(DEPLOYMENT_IDS.has(codex.id) && DEPLOYMENT_IDS.has(claude.id)).toBe(true)
  })

  it('the vLLM servers are listed as before', () => {
    expect(deploymentModels({
      FREE_DEPLOYMENT_INSTRUCT_URL: 'http://extraction_model:8000/v1',
      FREE_DEPLOYMENT_INSTRUCT_MODEL: ' Qwen/Qwen3.8-27B-FP8 ',
      FREE_DEPLOYMENT_NUEXTRACT_URL: 'http://nuextract_model:8000/v1',
      FREE_DEPLOYMENT_CLI_PROVIDERS: 'claude-code',
    })).toEqual({
      connections: [
        { id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment instruction model', provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1', hasKey: false },
        { id: DEPLOYMENT_CONNECTION_IDS.nuextract, name: 'Deployment NuExtract', provider: 'vllm', baseUrl: 'http://nuextract_model:8000/v1', hasKey: false },
        claude,
      ],
      defaultRoute: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: 'Qwen/Qwen3.8-27B-FP8' },
    })
    expect(deploymentModels({ FREE_DEPLOYMENT_INSTRUCT_URL: 'not a url' })).toEqual({ connections: [], defaultRoute: null })
  })
})
