import type { ModelConfigurationStore, ResearcherProjectStore } from 'db'
import { modelKeysRequestSchema, sameModelKeyAddress } from '../shared/modelKeys.contract.js'
import { ApiError, apiErrorResponse, json, noStore, parseJsonRequest } from './_http.js'
import { readAccountModelConfig } from './_model_config.js'
import { studioProcess, type ModelKeyCache } from './_model_keys.js'

const invalid = () => new ApiError(400, 'invalid_request', 'The request is invalid.')

/**
 * `PUT /api/model-keys`: the page hands Studio its keys for the signed-in account. Write-only; entries merge and
 * `null` removes one. A key is accepted only for one of the account's own `hasKey` connections at that connection's
 * current provider and base; anything else is skipped. Bodies are never logged or echoed.
 */
export function createPutModelKeys(
  researcherAccountId: string,
  dependencies: Readonly<{ configurations?: ModelConfigurationStore; keys?: ModelKeyCache }> = {},
) {
  const keys = dependencies.keys ?? studioProcess.keys
  return async function PUT(request: Request): Promise<Response> {
    // Begun before the first await: a sign-out while this request reads the configuration voids its writes.
    const handoff = keys.handoff(researcherAccountId)
    try {
      let body: unknown
      try {
        body = await parseJsonRequest(request)
      } catch {
        throw invalid()
      }
      const parsed = modelKeysRequestSchema.safeParse(body)
      if (!parsed.success) throw invalid()
      // A stale tab on a shared browser must not file one account's keys under another.
      if (parsed.data.account !== researcherAccountId)
        throw new ApiError(409, 'account_mismatch', 'These keys belong to another Researcher Account. Reload the page.')
      const own = new Map(
        (await readAccountModelConfig(researcherAccountId, dependencies.configurations)).connections.map((connection) => [connection.id, connection]),
      )
      const accepted: string[] = []
      for (const [id, entry] of Object.entries(parsed.data.keys)) {
        if (entry === null) {
          handoff.remove(id)
          accepted.push(id)
          continue
        }
        const connection = own.get(id)
        if (!connection?.hasKey || !sameModelKeyAddress(entry, connection)) continue
        if (handoff.put(id, { provider: entry.provider, baseUrl: entry.baseUrl }, entry.key)) accepted.push(id)
      }
      return json({ accepted }, { headers: noStore })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export function createResearcherApiHandlers(store: Pick<ResearcherProjectStore, 'researcherAccountId'>) {
  return { PUT: createPutModelKeys(store.researcherAccountId) }
}
