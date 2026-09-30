import { pool, type ResearcherProjectStore } from 'db'
import { sampleFactsRequest, sampleFactsResponse } from '../shared/sampleFacts.contract.js'
import { ApiError, json, noStore, noStoreError, parseJsonRequest, persistenceUnavailable } from './_http.js'

/** Read only selected sources and the selected revision; aggregate pages before sending, never load results/history. */
export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  return { POST: async (request: Request) => {
    try {
      const parsed = sampleFactsRequest.safeParse(await parseJsonRequest(request))
      if (!parsed.success) throw new ApiError(422, 'invalid_request', 'Choose one Schema Revision and 1–50 distinct sources.')
      const { projectContextId, schemaRevisionId, sourceDocumentIds } = parsed.data
      const result = await pool.query(`
        WITH selected AS (
          SELECT d.id, r.id AS pin FROM "sourceDocument" d
          JOIN "projectContext" p ON p.id = d."projectContextId" AND p."researcherAccountId" = $1
          JOIN "extractionSchema" s ON s."projectContextId" = p.id
          JOIN "schemaRevision" v ON v."extractionSchemaId" = s.id AND v.id = $4
          LEFT JOIN LATERAL (SELECT id FROM "sourceRepresentationRevision" WHERE "sourceDocumentId" = d.id
            ORDER BY "revisionNumber" DESC LIMIT 1) r ON true
          WHERE p.id = $2 AND d.id = ANY($3::uuid[])
        ), eligible AS (
          SELECT e.id, e."sourceDocumentId", e."requestedPages", e."reviewDraft" IS NOT NULL AS "hasDraft", e."reviewedAt", e.outcome
          FROM "extraction" e JOIN selected s ON s.id = e."sourceDocumentId" AND s.pin = e."sourceRepresentationRevisionId"
          WHERE e."schemaRevisionId" = $4
        )
        SELECT s.id AS "sourceDocumentId", s.pin AS "sourceRepresentationRevisionId",
          (count(e.id) FILTER (WHERE e."requestedPages" IS NOT NULL))::int AS admitted,
          (count(e.id) FILTER (WHERE e."requestedPages" IS NOT NULL AND e."hasDraft" AND e."reviewedAt" IS NULL))::int AS "savedDrafts",
          (count(e.id) FILTER (WHERE e."requestedPages" IS NOT NULL AND e."reviewedAt" IS NOT NULL))::int AS finalized,
          (count(e.id) FILTER (WHERE e."requestedPages" IS NULL AND e.outcome = 'SUCCEEDED'))::int AS "fullResults",
          ARRAY(SELECT DISTINCT page::int FROM eligible x, jsonb_array_elements_text(x."requestedPages") page WHERE x."sourceDocumentId" = s.id ORDER BY page::int) AS pages,
          ARRAY(SELECT DISTINCT page::int FROM eligible x, jsonb_array_elements_text(x."requestedPages") page WHERE x."sourceDocumentId" = s.id AND x."reviewedAt" IS NOT NULL ORDER BY page::int) AS "reviewedPages"
        FROM selected s LEFT JOIN eligible e ON e."sourceDocumentId" = s.id GROUP BY s.id, s.pin ORDER BY s.id
      `, [store.researcherAccountId, projectContextId, sourceDocumentIds, schemaRevisionId]).catch((cause: unknown) => { throw persistenceUnavailable(cause) })
      if (result.rows.length !== sourceDocumentIds.length) throw new ApiError(404, 'not_found', 'The selected sources or Schema Revision were not found.')
      return json(sampleFactsResponse.parse({ sources: result.rows }), { headers: noStore })
    } catch (error) { return noStoreError(error) }
  } }
}
