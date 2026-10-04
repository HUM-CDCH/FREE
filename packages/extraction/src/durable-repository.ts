import { randomUUID, createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { pool as sharedPool, stableJson } from 'db'
import { extractionMethod, keiMethodOptions, canonicalIntent } from './extraction-method.js'
import { parseExtractionSchema } from './schema.js'
import { keiRunOf } from './kei-handoff.js'
import { durableAdoptSchema, durableCommandSchema, durableCorrectionSchema, durableHeadSchema,
  durableSelectionSchema, durableStatus, durableValueSchema, type DurableHead, type DurableValue } from './durable-contract.js'
import { correctionValueFits, fieldMeaning } from './durable-feedback.js'

export class DurableConflict extends Error {
  constructor(message = 'The Extraction changed. Reload to review the saved state.') { super(message) }
}
export class DurableNotFound extends Error {}
export class DurableInvalid extends Error {}
const hash = (body: unknown) => createHash('sha256').update(stableJson(body)).digest('hex')
export const DURABLE_RECONCILE = 'reconcileDurableExtractions'

/** No connection outlives this short transaction. READ COMMITTED plus the
 * locked feedback head gives admission its latest committed publication. */
export async function runtimeTransaction<T>(source: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await source.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '10s'")
    const result = await work(client); await client.query('COMMIT'); return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
export async function ownedHead(client: PoolClient, owner: string, id: string, lock = false): Promise<DurableHead> {
  const result = await client.query(`SELECT h.* FROM extraction_runtime.head h
    JOIN public.extraction e ON e.id = h.id JOIN public."sourceDocument" d ON d.id = e."sourceDocumentId"
    JOIN public."projectContext" p ON p.id = d."projectContextId"
    WHERE h.id = $1 AND p."researcherAccountId" = $2 AND NOT h.deleted ${lock ? 'FOR UPDATE OF h' : ''}`, [id, owner])
  if (!result.rows.length) throw new DurableNotFound('That Extraction was not found.')
  return durableHeadSchema.parse(result.rows[0])
}
const version = (h: DurableHead, expected: number) => {
  if (h.controlVersion !== expected) throw new DurableConflict()
}
async function createAttempt(client: PoolClient, head: DurableHead): Promise<void> {
  const id = randomUUID(), workflow = `kei-durable:${head.id}:${id}`, fence = head.fence + 1
  await client.query(`INSERT INTO extraction_runtime.attempt
    (id, "extractionId", "selectionId", fence, "workflowId") VALUES ($1,$2,$3,$4,$5)`, [id, head.id, head.selectionId, fence, workflow])
  await client.query('INSERT INTO extraction_runtime.dispatch (id,"workflowId",received) VALUES ($1,$2,false)', [id, workflow])
  await client.query(`UPDATE extraction_runtime.head SET "attemptId"=$2, fence=$3, intent='RUN',
    acknowledgement='QUEUED', "pendingResume"=false, "leaseOwner"=NULL, "leaseUntil"=NULL WHERE id=$1`, [head.id, id, fence])
}
async function readHead(client: PoolClient, id: string) {
  return durableHeadSchema.parse((await client.query('SELECT * FROM extraction_runtime.head WHERE id=$1', [id])).rows[0])
}

/** Called inside the existing authenticated admission transaction. All pins
 * originate in public rows Studio already validated and locked. */
export async function initializeDurableExtraction(client: PoolClient, id: string, pins: {
  projectContextId: string; sourceRepresentationRevisionId: string; schemaRevisionId: string; schemaTree: unknown;
  strategy: 'ARTICLE' | 'CATALOG'; catalogRecipe: string | null; preprocessId: string;
  requestedModels: unknown; requestedSettings: unknown; startPage?: number | null
}): Promise<void> {
  const source = keiRunOf(pins.preprocessId)
  if (!source) throw new DurableInvalid('The pinned source is unavailable.')
  const representation = (await client.query(`SELECT "artifactReference", "artifactSha256" FROM public."sourceRepresentationRevision" WHERE id=$1`,
    [pins.sourceRepresentationRevisionId])).rows[0]
  const tree = parseExtractionSchema(pins.schemaTree), selection = randomUUID()
  await client.query('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES ($1,0) ON CONFLICT DO NOTHING', [pins.projectContextId])
  await client.query(`INSERT INTO extraction_runtime.head (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",
    intent,"controlVersion","pendingResume",acknowledgement,fence,"leaseEpoch",generation,"snapshotVersion",deleted)
    VALUES ($1,$2,$3,$4,$5,$6,'RUN',0,false,'QUEUED',0,0,1,0,false)`,
    [id,pins.projectContextId,pins.sourceRepresentationRevisionId,{...source,...representation,sourceRevisionId:pins.sourceRepresentationRevisionId},pins.strategy,selection])
  const method = canonicalIntent({models:pins.requestedModels,settings:pins.requestedSettings}, pins.strategy,pins.catalogRecipe)
  if (!method) throw new DurableInvalid('The Extraction method is invalid.')
  const resolved = { protocol: 1, plannerVersion: 1, promptVersion: 1, catalogRecipe: pins.catalogRecipe, options: {...keiMethodOptions(extractionMethod(pins.strategy,pins.catalogRecipe,pins.requestedModels,pins.requestedSettings)), ...(pins.startPage ? {start_page:pins.startPage} : {})}, startPage: pins.startPage ?? null }
  await client.query(`INSERT INTO extraction_runtime.selection
    (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
    VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`, [selection,id,pins.schemaRevisionId,hash(tree),tree,method,resolved,hash([tree,method,resolved,source])])
  await client.query(`INSERT INTO extraction_runtime."artifactReference" (id,"extractionId",reference,digest,generation,kind) VALUES ($1,$2,$3,$4,$5,'source')`,
    [randomUUID(),id,representation.artifactReference,representation.artifactSha256,source.generation])
  const manifest = {plannerVersion:1,selectionId:selection,sourceGeneration:source.generation,units:[],coverage:{snapshotId:null,reprocessValueIds:[]}}
  await client.query(`INSERT INTO extraction_runtime.plan (id,"extractionId",generation,stage,digest,manifest) VALUES ($1,$2,1,'historical-coverage',$3,$4)`, [randomUUID(),id,hash(manifest),manifest])
  await createAttempt(client, await readHead(client,id))
}

export function createDurableRepository(owner: string, source: Pool = sharedPool) {
  const owned = <T>(id: string, work: (client: PoolClient, head: DurableHead) => Promise<T>, lock = false) =>
    runtimeTransaction(source, async client => work(client, await ownedHead(client,owner,id,lock)))
  return {
    async capability(id: string): Promise<boolean> {
      return runtimeTransaction(source, async client => {
        // The public ownership join precedes capability disclosure.
        const result = await client.query(`SELECT EXISTS (SELECT FROM extraction_runtime.head h WHERE h.id=e.id) AS durable
          FROM public.extraction e JOIN public."sourceDocument" d ON d.id=e."sourceDocumentId"
          JOIN public."projectContext" p ON p.id=d."projectContextId" WHERE e.id=$1 AND p."researcherAccountId"=$2`, [id,owner])
        return result.rows[0]?.durable ?? false
      })
    },
    read(id: string) { return owned(id, async (client,head) => {
      const selection = (await client.query('SELECT * FROM extraction_runtime.selection WHERE id=$1', [head.selectionId])).rows[0]
      const pendingSelection = head.pendingSelectionId ? (await client.query('SELECT * FROM extraction_runtime.selection WHERE id=$1', [head.pendingSelectionId])).rows[0] : null
      const counts = (await client.query(`SELECT count(*) FILTER (WHERE "inFlight")::int AS "inFlight",
        count(*) FILTER (WHERE o.id IS NOT NULL)::int AS saved,
        count(*) FILTER (WHERE o.id IS NULL)::int AS pending FROM extraction_runtime.capture c
        LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id WHERE c."extractionId"=$1`, [id])).rows[0]
      return { protocol:1 as const, extractionId:id, status:durableStatus(head), controlVersion:head.controlVersion,
        pendingResume:head.pendingResume, selection,pendingSelection, source:head.sourcePin,
        sourceRevisionId:head.sourceRevisionId,snapshotVersion:head.snapshotVersion,counts }
    }) },
    command(id: string, raw: unknown) {
      const command = durableCommandSchema.parse(raw)
      return owned(id, async (client,head) => {
        const prior = (await client.query('SELECT * FROM extraction_runtime.command WHERE id=$1', [command.id])).rows[0]
        if (prior) {
          if (prior.extractionId !== id || stableJson(prior.payload) !== stableJson(command)) throw new DurableConflict('Command ID reused for another request.')
          return prior.response
        }
        version(head,command.expectedVersion)
        if (head.intent === 'STOP') throw new DurableConflict('Stopped Extractions cannot resume or retry.')
        const idle = ['PAUSED','FAILED','COMPLETED'].includes(head.acknowledgement)
        if (command.action === 'resume' || command.action === 'retry') {
          if (head.pendingSelectionId) throw new DurableConflict('Changes pending — apply or discard, then resume.')
          if (head.acknowledgement === 'COMPLETED') throw new DurableConflict('The Extraction is complete.')
          if (idle) await createAttempt(client,head)
          else if (head.intent === 'PAUSE') await client.query('UPDATE extraction_runtime.head SET "pendingResume"=true WHERE id=$1', [id])
          else throw new DurableConflict('The Extraction is already running.')
        } else if (command.action === 'pause' || command.action === 'editing') {
          await client.query(`UPDATE extraction_runtime.head SET intent='PAUSE', "pendingResume"=false,
            "pendingSelectionId"=CASE WHEN $2 THEN coalesce("pendingSelectionId","selectionId") ELSE "pendingSelectionId" END,
            acknowledgement=CASE WHEN acknowledgement IN ('FAILED','COMPLETED') THEN acknowledgement ELSE acknowledgement END WHERE id=$1`, [id,command.action === 'editing'])
        } else if (command.action === 'stop') {
          await client.query(`UPDATE extraction_runtime.head SET intent='STOP', "pendingResume"=false,
            acknowledgement=CASE WHEN $2 THEN 'STOPPED' ELSE acknowledgement END WHERE id=$1`, [id,idle])
        } else {
          await client.query('UPDATE extraction_runtime.head SET "pendingSelectionId"=NULL,"pendingResume"=false WHERE id=$1', [id])
        }
        await client.query('UPDATE extraction_runtime.head SET "controlVersion"="controlVersion"+1 WHERE id=$1', [id])
        const next = await readHead(client,id)
        const response = { controlVersion:next.controlVersion,status:durableStatus(next),pendingResume:next.pendingResume }
        await client.query('INSERT INTO extraction_runtime.command (id,"extractionId",payload,response) VALUES ($1,$2,$3,$4)', [command.id,id,command,response])
        return response
      },true)
    },
    saveSelection(id: string, raw: unknown) {
      const input = durableSelectionSchema.parse(raw)
      return owned(id, async (client,head) => {
        version(head,input.expectedVersion)
        if (head.intent === 'STOP') throw new DurableConflict('Stopped Extractions cannot change their inputs.')
        const row = (await client.query(`SELECT r.* FROM public."schemaRevision" r
          JOIN public."extractionSchema" s ON s.id=r."extractionSchemaId"
          WHERE r.id=$1 AND s."projectContextId"=$2`, [input.schemaRevisionId,head.projectId])).rows[0]
        if (!row || row.recordScope !== (head.strategy === 'ARTICLE' ? 'document' : 'records')) throw new DurableInvalid('Choose a Schema Revision with the same strategy in this Project.')
        const tree = parseExtractionSchema(row.schemaTree)
        const prior = (await client.query('SELECT method,resolved FROM extraction_runtime.selection WHERE id=$1', [head.selectionId])).rows[0]
        const method = canonicalIntent(input.method,head.strategy,prior.resolved.catalogRecipe)
        if (!method) throw new DurableInvalid('The Extraction settings are invalid.')
        const ordinal = (await client.query('SELECT coalesce(max(ordinal),0)+1 AS n FROM extraction_runtime.selection WHERE "extractionId"=$1', [id])).rows[0].n
        const selectionId = randomUUID()
        await client.query(`INSERT INTO extraction_runtime.selection
          (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [selectionId,id,ordinal,input.schemaRevisionId,hash(tree),tree,method,{...prior.resolved,options:keiMethodOptions(extractionMethod(head.strategy,prior.resolved.catalogRecipe,method.models,method.settings))},hash([tree,method,prior.resolved,head.sourcePin])])
        await client.query(`UPDATE extraction_runtime.head SET "pendingSelectionId"=$2,intent='PAUSE',
          "pendingResume"=false,"controlVersion"="controlVersion"+1 WHERE id=$1`, [id,selectionId])
        return { selectionId,controlVersion:head.controlVersion+1 }
      },true)
    },
    adoptSelection(id: string, raw: unknown) {
      const input = durableAdoptSchema.parse(raw)
      return owned(id, async (client,head) => {
        version(head,input.expectedVersion)
        if (!['PAUSED','FAILED','COMPLETED'].includes(head.acknowledgement) || head.intent === 'STOP' || head.pendingSelectionId !== input.selectionId)
          throw new DurableConflict('Apply changes at the saved idle boundary.')
        const historical = (await client.query('SELECT * FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2', [id,head.snapshotVersion])).rows[0]
        const values = historical ? durableValueSchema.array().parse(historical.values) : []
        if (input.reprocessValueIds.some(v => !values.some(saved => saved.id === v))) throw new DurableInvalid('The reprocessing selection contains an unknown saved value.')
        await client.query(`UPDATE extraction_runtime.head SET "selectionId"=$2,"pendingSelectionId"=NULL,generation=generation+1,
          "pendingResume"=false,acknowledgement='PAUSED',intent='PAUSE',"controlVersion"="controlVersion"+1 WHERE id=$1`, [id,input.selectionId])
        // The fixed historical snapshot is a planner input. It cannot grow on replay.
        await client.query(`INSERT INTO extraction_runtime.plan (id,"extractionId",generation,stage,digest,manifest) VALUES ($1,$2,$3,'historical-coverage',$4,$5)`, [randomUUID(),id,head.generation+1,
          hash([historical?.id ?? null,input.reprocessValueIds]),{plannerVersion:1,selectionId:input.selectionId,sourceGeneration:head.sourcePin.generation,
            units:[],coverage:{snapshotId:historical?.id ?? null,reprocessValueIds:input.reprocessValueIds}}])
        return { selectionId:input.selectionId,controlVersion:head.controlVersion+1 }
      },true)
    },
    page(id: string, input: { snapshotVersion?: number; feedbackVersion?: number; offset?: number; limit?: number } = {}) {
      return owned(id,async (client,head) => {
        const snapshotVersion = input.snapshotVersion ?? head.snapshotVersion
        const snapshot = (await client.query('SELECT * FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2', [id,snapshotVersion])).rows[0]
        if (!snapshot && snapshotVersion !== 0) throw new DurableNotFound('That saved result snapshot is unavailable.')
        const feedbackVersion = input.feedbackVersion ?? (await client.query('SELECT version FROM extraction_runtime."feedbackHead" WHERE id=$1', [head.projectId])).rows[0].version
        const corrections = (await client.query(`SELECT DISTINCT ON ("valueId") * FROM extraction_runtime.correction
          WHERE "extractionId"=$1 AND "feedbackVersion" <= $2 ORDER BY "valueId",revision DESC`, [id,feedbackVersion])).rows
        const values = snapshot ? durableValueSchema.array().parse(snapshot.values) : []
        const offset = input.offset ?? 0, limit = Math.min(input.limit ?? 100,500)
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new DurableInvalid('Invalid result page.')
        return { extractionId:id, snapshotVersion,feedbackVersion, status:durableStatus(head),coverage:snapshot?.coverage ?? null,
          total:values.length, values:values.slice(offset,offset+limit).map(value => ({...value,correction:corrections.find(c=>c.valueId===value.id) ?? null})),
          next:offset+limit < values.length ? {snapshotVersion,feedbackVersion,offset:offset+limit,limit} : null }
      })
    },
    saveCorrection(id: string, valueId: string, raw: unknown, validateEvidence: (value: DurableValue, evidence: {anchorId:string;occurrenceIds:string[]}[], sourceRevisionId: string) => Promise<void>) {
      const input = durableCorrectionSchema.parse(raw)
      return runtimeTransaction(source,async client => {
        const initial = await ownedHead(client,owner,id)
        const feedback = (await client.query('SELECT version FROM extraction_runtime."feedbackHead" WHERE id=$1 FOR UPDATE', [initial.projectId])).rows[0]
        const head = await ownedHead(client,owner,id)
        const snapshot = (await client.query('SELECT values FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2', [id,input.snapshotVersion])).rows[0]
        const value = snapshot ? durableValueSchema.array().parse(snapshot.values).find(v=>v.id===valueId) : null
        if (!value || value.processing !== 'saved') throw new DurableInvalid('Choose a structurally valid saved value.')
        if (input.action === 'EDITED' && !correctionValueFits(value.node,input.value)) throw new DurableInvalid('The correction does not fit its producing field.')
        await validateEvidence(value,input.evidence,head.sourceRevisionId)
        const revision = (await client.query('SELECT coalesce(max(revision),0) AS n FROM extraction_runtime.correction WHERE "extractionId"=$1 AND "valueId"=$2', [id,valueId])).rows[0].n
        if (revision !== input.expectedRevision) throw new DurableConflict('Another view saved a newer correction.')
        const feedbackVersion = feedback.version+1, correctionId = randomUUID()
        const candidate = {id:correctionId,fieldId:value.fieldId,meaning:fieldMeaning(value.node),value:input.value ?? null,
          sourceContext:stableJson({sourceRevisionId:head.sourceRevisionId,recordId:value.recordId,modelValue:value.modelValue}),grounded:input.evidence.length>0}
        const included = input.included && input.action === 'EDITED'
        await client.query(`INSERT INTO extraction_runtime.correction
          (id,"projectId","extractionId","valueId",revision,"feedbackVersion","snapshotVersion","selectionId",decision,candidate,included)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [correctionId,head.projectId,id,valueId,revision+1,feedbackVersion,input.snapshotVersion,value.selectionId,input,candidate,included])
        await client.query('UPDATE extraction_runtime."feedbackHead" SET version=$2 WHERE id=$1', [head.projectId,feedbackVersion])
        return { id:correctionId,revision:revision+1,feedbackVersion,included }
      })
    },
    feedback(projectId: string) { return runtimeTransaction(source,async client=> {
      const owns = await client.query('SELECT id FROM public."projectContext" WHERE id=$1 AND "researcherAccountId"=$2', [projectId,owner])
      if (!owns.rowCount) throw new DurableNotFound('That Project was not found.')
      return (await client.query('SELECT * FROM extraction_runtime.correction WHERE "projectId"=$1 ORDER BY "feedbackVersion" DESC', [projectId])).rows
    }) },
  }
}

/** Reconciliation reads committed handoffs, enqueues deterministic identities,
 * and records the receipt. A crash between these operations re-enqueues safely. */
export async function reconcileDurableAttempts(enqueue: (attempt: {id:string;extractionId:string;workflowId:string;owner:string;sourcePin:unknown}) => Promise<void>, source: Pool = sharedPool) {
  await runtimeTransaction(source,async client => {
    const heads = (await client.query(`SELECT * FROM extraction_runtime.head WHERE "pendingResume"
      AND acknowledgement IN ('PAUSED','FAILED') AND intent='PAUSE' AND NOT deleted AND "pendingSelectionId" IS NULL FOR UPDATE`)).rows
    for (const raw of heads) await createAttempt(client,durableHeadSchema.parse(raw))
  })
  const rows = await source.query(`SELECT a.id,a."extractionId",a."workflowId",p."researcherAccountId" AS owner,h."sourcePin"
    FROM extraction_runtime.dispatch d JOIN extraction_runtime.attempt a ON a.id=d.id
    JOIN extraction_runtime.head h ON h.id=a."extractionId" JOIN public.extraction e ON e.id=h.id
    JOIN public."sourceDocument" s ON s.id=e."sourceDocumentId" JOIN public."projectContext" p ON p.id=s."projectContextId"
    WHERE NOT d.received AND NOT h.deleted AND h."attemptId"=a.id LIMIT 100`)
  for (const row of rows.rows) {
    await enqueue(row)
    await source.query('UPDATE extraction_runtime.dispatch SET received=true WHERE id=$1', [row.id])
  }
}
