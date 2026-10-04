import type { Pool } from 'pg'
import { pool as sharedPool, stableJson } from 'db'
import { createHash } from 'node:crypto'
import { legacyValueId } from './durable-feedback.js'
import { DurableNotFound, runtimeTransaction } from './durable-repository.js'

/** Historical identity is bound to the original artifact and path. It never
 * establishes equivalence to a reordered/reprocessed result or current schema. */
export function legacyIdentityMap(extractionId: string, artifact: unknown) {
  const artifactDigest = createHash('sha256').update(stableJson(artifact)).digest('hex')
  const identities: {id:string;path:(string|number)[]}[] = []
  const visit = (value:unknown,path:(string|number)[]) => {
    if (Array.isArray(value)) { value.forEach((child,index)=>visit(child,[...path,index])); return }
    if (value !== null && typeof value === 'object') {
      for (const [key,child] of Object.entries(value)) visit(child,[...path,key])
      return
    }
    identities.push({id:legacyValueId(extractionId,artifactDigest,path),path})
  }
  visit(artifact,[])
  return {artifactDigest,identities}
}

export async function readLegacyExtraction(owner:string,id:string,source:Pool=sharedPool) {
  return runtimeTransaction(source,async client=> {
    const result=await client.query(`SELECT e.* FROM public.extraction e
      JOIN public."sourceDocument" d ON d.id=e."sourceDocumentId"
      JOIN public."projectContext" p ON p.id=d."projectContextId"
      WHERE e.id=$1 AND p."researcherAccountId"=$2`,[id,owner])
    const row=result.rows[0]
    if (!row) throw new DurableNotFound('That Extraction was not found.')
    if (row.resultPayload === null) return {protocol:0 as const,extraction:row,identityMap:null,artifactAvailability:'unavailable' as const}
    const map=legacyIdentityMap(id,row.resultPayload)
    for (const identity of map.identities)
      await client.query(`INSERT INTO extraction_runtime."legacyIdentity" (id,"extractionId","artifactDigest",path)
        VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,[identity.id,id,map.artifactDigest,JSON.stringify(identity.path)])
    return {protocol:0 as const,extraction:row,identityMap:map,artifactAvailability:'available' as const}
  })
}
