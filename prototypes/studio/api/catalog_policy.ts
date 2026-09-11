import { readCatalogPolicy, writeCatalogPolicy } from './_catalog_policy.js'
import { apiErrorResponse, json, noStore, parseJsonRequest } from './_http.js'

export async function GET(): Promise<Response> {
  try {
    return json(await readCatalogPolicy(), { headers: noStore })
  } catch (error) {
    return apiErrorResponse(error)
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    return json(await writeCatalogPolicy(await parseJsonRequest(request)), { headers: noStore })
  } catch (error) {
    return apiErrorResponse(error)
  }
}
