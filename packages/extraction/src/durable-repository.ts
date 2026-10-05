import { randomUUID, createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { pool as sharedPool, stableJson, withPoolClientTransaction } from 'db'
import { extractionMethod, keiMethodOptions, canonicalIntent } from './extraction-method.js'
import { parseExtractionSchema, type SchemaNode } from './schema.js'
import { keiRunOf } from './kei-handoff.js'
import { durableAdoptSchema, durableCommandSchema, durableCorrectionSchema, durableHeadSchema,
  durableSelectionSchema, durableStatus, durableValueSchema, type DurableHead, type DurableValue } from './durable-contract.js'
import { correctionValueFits, fieldMeaning, adaptedCorrection } from './durable-feedback.js'
import { refuseUnusableIdentityFields } from './postgres-admission.js'
import { refuseIncompatibleGliformer } from './gliformer-compatibility.js'
import { groundedEvidenceLink, plainEvidenceLink, unifiedEvidenceLink } from './kei-evidence.js'

export class DurableConflict extends Error {
  constructor(message = 'The Extraction changed. Reload to review the saved state.') { super(message) }
}
export class DurableNotFound extends Error {}
export class DurableInvalid extends Error {}
const hash = (body: unknown) => createHash('sha256').update(stableJson(body)).digest('hex')
const modelDigest = (value: DurableValue) => hash([value.selectionId,value.node,value.modelValue])
function reviewFits(correction: {candidate:{meaning:string;node:SchemaNode;modelDigest:string};decision:{action:string;value?:unknown;snapshotVersion?:number}}, value: DurableValue): boolean {
  if(correction.candidate.meaning!==fieldMeaning(value.node)) return false
  if(correction.decision.action==='EDITED') return adaptedCorrection(correction.candidate.node,value.node,correction.decision.value)!==undefined
  return correction.candidate.modelDigest===modelDigest(value)
}
function executionDefinition(raw:unknown) {
  if(raw && typeof raw==='object' && !Array.isArray(raw)) {
    const {recordScope: _scope,...definition}=raw as Record<string,unknown>
    return parseExtractionSchema(definition)
  }
  return parseExtractionSchema(raw)
}
export const DURABLE_RECONCILE = 'reconcileDurableExtractions'

/** No connection outlives this short transaction. READ COMMITTED plus the
 * locked feedback head gives admission its latest committed publication. */
export async function runtimeTransaction<T>(source: Pool, work: (client: PoolClient) => Promise<T>, isolation:'READ COMMITTED'|'REPEATABLE READ'='READ COMMITTED'): Promise<T> {
  return withPoolClientTransaction(async (_transaction, client) => {
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`)
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '10s'")
    return work(client)
  }, source)
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
  const tree = {...parseExtractionSchema(pins.schemaTree),recordScope:pins.strategy==='ARTICLE'?'document':'records'}, selection = randomUUID()
  await client.query('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES ($1,0) ON CONFLICT DO NOTHING', [pins.projectContextId])
  await client.query(`INSERT INTO extraction_runtime.head (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",
    intent,"controlVersion","pendingResume",acknowledgement,fence,"leaseEpoch",generation,"snapshotVersion",deleted)
    VALUES ($1,$2,$3,$4,$5,$6,'RUN',0,false,'QUEUED',0,0,1,0,false)`,
    [id,pins.projectContextId,pins.sourceRepresentationRevisionId,{...source,...representation,sourceRevisionId:pins.sourceRepresentationRevisionId},pins.strategy,selection])
  await client.query(`INSERT INTO extraction_runtime."artifactReference" (id,"extractionId",reference,digest,generation,kind)
    VALUES ($1,$2,$3,$4,$5,'source')`,[randomUUID(),id,representation.artifactReference,representation.artifactSha256,source.generation])
  const method = canonicalIntent({models:pins.requestedModels,settings:pins.requestedSettings}, pins.strategy,pins.catalogRecipe)
  if (!method) throw new DurableInvalid('The Extraction method is invalid.')
  const resolved = { protocol: 1, plannerVersion: 1, promptVersion: 1, catalogRecipe: pins.catalogRecipe, options: {...keiMethodOptions(extractionMethod(pins.strategy,pins.catalogRecipe,pins.requestedModels,pins.requestedSettings)), ...(pins.startPage ? {start_page:pins.startPage} : {})}, startPage: pins.startPage ?? null }
  await client.query(`INSERT INTO extraction_runtime.selection
    (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
    VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`, [selection,id,pins.schemaRevisionId,hash(tree),tree,method,resolved,hash([tree,method,resolved,source])])
  const manifest = {plannerVersion:1,selectionId:selection,sourceGeneration:source.generation,units:[],coverage:{snapshotId:null,reprocessValueIds:[]}}
  await client.query(`INSERT INTO extraction_runtime.plan (id,"extractionId",generation,stage,digest,manifest) VALUES ($1,$2,1,'historical-coverage',$3,$4)`, [randomUUID(),id,hash(manifest),manifest])
  await createAttempt(client, await readHead(client,id))
}

export function createDurableRepository(owner: string, source: Pool = sharedPool) {
  const owned = <T>(id: string, work: (client: PoolClient, head: DurableHead) => Promise<T>, lock = false) =>
    runtimeTransaction(source, async client => work(client, await ownedHead(client,owner,id,lock)))
  return {
    read(id: string) { return owned(id, async (client,head) => {
      const selection = (await client.query('SELECT * FROM extraction_runtime.selection WHERE id=$1', [head.selectionId])).rows[0]
      const pendingSelection = head.pendingSelectionId ? (await client.query('SELECT * FROM extraction_runtime.selection WHERE id=$1', [head.pendingSelectionId])).rows[0] : null
      const failure=head.attemptId?(await client.query('SELECT failure FROM extraction_runtime.attempt WHERE id=$1',[head.attemptId])).rows[0]?.failure??null:null
      const counts = (await client.query(`SELECT count(*) FILTER (WHERE "inFlight")::int AS "inFlight",
        count(*) FILTER (WHERE o.id IS NOT NULL)::int AS saved,
        count(*) FILTER (WHERE o.id IS NULL)::int AS pending FROM extraction_runtime.capture c
        LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id WHERE c."extractionId"=$1`, [id])).rows[0]
      return { protocol:1 as const, projectId:head.projectId, extractionId:id, status:durableStatus(head), controlVersion:head.controlVersion,
        pendingResume:head.pendingResume, selection,pendingSelection, source:head.sourcePin,
        sourceRevisionId:head.sourceRevisionId,snapshotVersion:head.snapshotVersion,counts,failure }
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
        const tree = {...parseExtractionSchema(row.schemaTree),recordScope:row.recordScope}
        const prior = (await client.query('SELECT method,resolved FROM extraction_runtime.selection WHERE id=$1', [head.selectionId])).rows[0]
        const method = canonicalIntent(input.method,head.strategy,prior.resolved.catalogRecipe)
        if (!method) throw new DurableInvalid('The Extraction settings are invalid.')
        refuseUnusableIdentityFields(method.settings,tree)
        refuseIncompatibleGliformer(method,executionDefinition(tree))
        const ordinal = (await client.query('SELECT coalesce(max(ordinal),0)+1 AS n FROM extraction_runtime.selection WHERE "extractionId"=$1', [id])).rows[0].n
        const selectionId = randomUUID()
        const resolved = {...prior.resolved,options:{...keiMethodOptions(extractionMethod(head.strategy,prior.resolved.catalogRecipe,method.models,method.settings)),
          ...(prior.resolved.startPage ? {start_page:prior.resolved.startPage} : {})}}
        await client.query(`INSERT INTO extraction_runtime.selection
          (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [selectionId,id,ordinal,input.schemaRevisionId,hash(tree),tree,method,resolved,hash([tree,method,resolved,head.sourcePin])])
        await client.query(`UPDATE extraction_runtime.head SET "pendingSelectionId"=$2,intent='PAUSE',
          "pendingResume"=false,"controlVersion"="controlVersion"+1 WHERE id=$1`, [id,selectionId])
        return { selectionId,controlVersion:head.controlVersion+1 }
      },true)
    },
    adoptSelection(id: string, raw: unknown) {
      const input = durableAdoptSchema.parse(raw)
      return owned(id, async (client,head) => {
        version(head,input.expectedVersion)
        if (!['PAUSED','FAILED','COMPLETED'].includes(head.acknowledgement) || head.intent === 'STOP' || head.pendingSelectionId !== input.selectionId || input.selectionId === head.selectionId)
          throw new DurableConflict('Apply changes at the saved idle boundary.')
        const historical = (await client.query('SELECT * FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2', [id,head.snapshotVersion])).rows[0]
        const values = historical ? durableValueSchema.array().parse(historical.values) : []
        if (input.reprocessValueIds.some(v => !values.some(saved => saved.id === v))) throw new DurableInvalid('The reprocessing selection contains an unknown saved value.')
        await client.query(`UPDATE extraction_runtime.head SET "selectionId"=$2,"pendingSelectionId"=NULL,generation=generation+1,
          "pendingResume"=false,acknowledgement='PAUSED',intent='PAUSE',"controlVersion"="controlVersion"+1 WHERE id=$1`, [id,input.selectionId])
        // The fixed historical snapshot is a planner input. It cannot grow on replay.
        const manifest = {plannerVersion:1,selectionId:input.selectionId,sourceGeneration:head.sourcePin.generation,
          units:[],coverage:{snapshotId:historical?.id ?? null,reprocessValueIds:input.reprocessValueIds}}
        await client.query(`INSERT INTO extraction_runtime.plan (id,"extractionId",generation,stage,digest,manifest) VALUES ($1,$2,$3,'historical-coverage',$4,$5)`,
          [randomUUID(),id,head.generation+1,hash(manifest),manifest])
        return { selectionId:input.selectionId,controlVersion:head.controlVersion+1 }
      },true)
    },
    page(id: string, input: { snapshotVersion?: number; feedbackVersion?: number; offset?: number; limit?: number; valueId?: string } = {}) {
      return owned(id,async (client,head) => {
        const snapshotVersion = input.snapshotVersion ?? head.snapshotVersion
        const snapshot = (await client.query('SELECT * FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2', [id,snapshotVersion])).rows[0]
        if (!snapshot && snapshotVersion !== 0) throw new DurableNotFound('That saved result snapshot is unavailable.')
        const feedbackVersion = input.feedbackVersion ?? (await client.query('SELECT version FROM extraction_runtime."feedbackHead" WHERE id=$1', [head.projectId])).rows[0].version
        const latestFeedback = (await client.query('SELECT version FROM extraction_runtime."feedbackHead" WHERE id=$1', [head.projectId])).rows[0].version
        if (!Number.isInteger(snapshotVersion) || snapshotVersion < 0 || snapshotVersion > head.snapshotVersion ||
          !Number.isInteger(feedbackVersion) || feedbackVersion < 0 || feedbackVersion > latestFeedback)
          throw new DurableInvalid('Choose a committed result and review snapshot.')
        const corrections = (await client.query(`SELECT DISTINCT ON ("valueId") * FROM extraction_runtime.correction
          WHERE "extractionId"=$1 AND "feedbackVersion" <= $2 ORDER BY "valueId",revision DESC`, [id,feedbackVersion])).rows
        const correctionsByValue = new Map(corrections.map(correction=>[correction.valueId,correction]))
        const allValues = snapshot ? durableValueSchema.array().parse(snapshot.values) : []
        const values=input.valueId?allValues.filter(v=>v.id===input.valueId):allValues
        const offset = input.offset ?? 0, limit = Math.min(input.limit ?? 100,500)
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw new DurableInvalid('Invalid result page.')
        const finalization = (await client.query(`SELECT id,"snapshotVersion","feedbackVersion","createdAt" FROM extraction_runtime.finalization
          WHERE "extractionId"=$1 AND "snapshotVersion"=$2 AND "feedbackVersion"=$3`, [id,snapshotVersion,feedbackVersion])).rows[0] ?? null
        const projected = allValues.map(value => {
            const historicalCorrection = correctionsByValue.get(value.id) ?? null
            const compatible=historicalCorrection===null || reviewFits(historicalCorrection,value)
            const links=value.evidence.map(({anchorId,producer}) => {
              if ('provenance' in producer) return groundedEvidenceLink(producer,anchorId)
              if ('support' in producer) return unifiedEvidenceLink(producer,anchorId)
              return plainEvidenceLink(producer,anchorId)
            })
            return {...value,links,correction:compatible && historicalCorrection ? {...historicalCorrection,decision:{...historicalCorrection.decision,...(historicalCorrection.decision.action==='EDITED'?{value:adaptedCorrection(historicalCorrection.candidate.node,value.node,historicalCorrection.decision.value)}:{})}} : null,historicalCorrection:compatible ? null : historicalCorrection,
              correctionCompatibility:compatible ? 'compatible' : 'incompatible'}
          })
        const saved=projected.filter(value=>value.processing==='saved')
        const count=(action:string)=>saved.filter(value=>value.correction?.decision.action===action).length
        const reviewCounts={required:saved.length,approved:count('APPROVED'),edited:count('EDITED'),rejected:count('REJECTED'),
          toCheck:saved.filter(value=>!value.correction||value.correction.decision.action==='PENDING').length}
        const selected=input.valueId?projected.filter(value=>value.id===input.valueId):projected
        return { extractionId:id,snapshotVersion,feedbackVersion,finalization,reviewCounts,status:durableStatus(head),coverage:snapshot?.coverage??null,
          total:values.length,values:selected.slice(offset,offset+limit),
          next:offset+limit < values.length ? {snapshotVersion,feedbackVersion,offset:offset+limit,limit} : null }
      })
    },
    async saveCorrection(id: string, valueId: string, raw: unknown, validateEvidence: (value: DurableValue, evidence: {anchorId:string;occurrenceIds:string[]}[], sourceRevisionId: string) => Promise<Record<string,unknown> | void>) {
      const input = durableCorrectionSchema.parse(raw)
      const validated = await owned(id,async(client,head)=> {
        const snapshot=(await client.query('SELECT values FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2',[id,input.snapshotVersion])).rows[0]
        const value=snapshot?durableValueSchema.array().parse(snapshot.values).find(v=>v.id===valueId):null
        if(!value) throw new DurableInvalid('Choose a saved value.')
        return {value,sourceRevisionId:head.sourceRevisionId}
      })
      // Artifact reads happen before the short publication transaction. The
      // source and snapshot pins used here are immutable and rechecked below.
      const context=await validateEvidence(validated.value,input.evidence,validated.sourceRevisionId)
      return runtimeTransaction(source,async client => {
        const initial = await ownedHead(client,owner,id)
        const feedback = (await client.query('SELECT version FROM extraction_runtime."feedbackHead" WHERE id=$1 FOR UPDATE', [initial.projectId])).rows[0]
        const head = await ownedHead(client,owner,id,true)
        const snapshot = (await client.query('SELECT values FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2', [id,input.snapshotVersion])).rows[0]
        const value = snapshot ? durableValueSchema.array().parse(snapshot.values).find(v=>v.id===valueId) : null
        if (!value || value.processing !== 'saved') throw new DurableInvalid('Choose a structurally valid saved value.')
        if (input.action === 'EDITED' && !correctionValueFits(value.node,input.value)) throw new DurableInvalid('The correction does not fit its producing field.')
        const revision = (await client.query('SELECT coalesce(max(revision),0) AS n FROM extraction_runtime.correction WHERE "extractionId"=$1 AND "valueId"=$2', [id,valueId])).rows[0].n
        if (revision !== input.expectedRevision) throw new DurableConflict('Another view saved a newer correction.')
        const feedbackVersion = feedback.version+1, correctionId = randomUUID()
        const candidate = {id:correctionId,fieldId:value.fieldId,meaning:fieldMeaning(value.node),node:value.node,modelDigest:modelDigest(value),value:input.value ?? null,
          sourceContext:stableJson({...context,sourceRevisionId:head.sourceRevisionId,recordId:value.recordId,modelValue:value.modelValue}),grounded:input.evidence.length>0}
        const included = input.included && input.action === 'EDITED'
        await client.query(`INSERT INTO extraction_runtime.correction
          (id,"projectId","extractionId","valueId",revision,"feedbackVersion","snapshotVersion","selectionId",decision,candidate,included)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [correctionId,head.projectId,id,valueId,revision+1,feedbackVersion,input.snapshotVersion,value.selectionId,input,candidate,included])
        await client.query('UPDATE extraction_runtime."feedbackHead" SET version=$2 WHERE id=$1', [head.projectId,feedbackVersion])
        return { id:correctionId,revision:revision+1,feedbackVersion,included }
      })
    },
    history(id: string) { return runtimeTransaction(source,async (client)=> {
      await ownedHead(client,owner,id)
      return {
      capturedAt:(await client.query('SELECT transaction_timestamp() AS at')).rows[0].at.toISOString(),
      selections:(await client.query('SELECT * FROM extraction_runtime.selection WHERE "extractionId"=$1 ORDER BY ordinal',[id])).rows,
      snapshots:(await client.query('SELECT * FROM extraction_runtime.snapshot WHERE "extractionId"=$1 ORDER BY version',[id])).rows,
      corrections:(await client.query('SELECT * FROM extraction_runtime.correction WHERE "extractionId"=$1 ORDER BY "feedbackVersion"',[id])).rows,
      finalizations:(await client.query('SELECT * FROM extraction_runtime.finalization WHERE "extractionId"=$1 ORDER BY "createdAt"',[id])).rows,
      effective:(await client.query('SELECT e.* FROM extraction_runtime.effective e JOIN extraction_runtime.selection s ON s.id=e.id WHERE s."extractionId"=$1',[id])).rows,
      plans:(await client.query('SELECT * FROM extraction_runtime.plan WHERE "extractionId"=$1 ORDER BY generation,stage',[id])).rows,
      captures:(await client.query(`SELECT c.*,i.digest AS "inputDigest",i.request,o."outputDigest",o.output FROM extraction_runtime.capture c
        LEFT JOIN extraction_runtime.input i ON i.id=c.id LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id WHERE c."extractionId"=$1 ORDER BY c.generation,c."unitKey"`,[id])).rows,
      failedCalls:(await client.query('SELECT f.* FROM extraction_runtime."callFailure" f JOIN extraction_runtime.capture c ON c.id=f."captureId" WHERE c."extractionId"=$1',[id])).rows,
      attempts:(await client.query('SELECT * FROM extraction_runtime.attempt WHERE "extractionId"=$1 ORDER BY fence',[id])).rows,
    }},'REPEATABLE READ') },
    finalize(id: string, input: {snapshotVersion:number;feedbackVersion:number}) { return owned(id,async(client,head)=> {
      const snapshot=(await client.query('SELECT values FROM extraction_runtime.snapshot WHERE "extractionId"=$1 AND version=$2',[id,input.snapshotVersion])).rows[0]
      const feedback=(await client.query('SELECT version FROM extraction_runtime."feedbackHead" WHERE id=$1',[head.projectId])).rows[0]
      if(!snapshot || !Number.isInteger(input.feedbackVersion) || input.feedbackVersion<0 || input.feedbackVersion>feedback.version) throw new DurableInvalid('Choose a committed review snapshot.')
      const decisions=(await client.query(`SELECT DISTINCT ON ("valueId") * FROM extraction_runtime.correction
        WHERE "extractionId"=$1 AND "feedbackVersion"<=$2 ORDER BY "valueId",revision DESC`,[id,input.feedbackVersion])).rows
      const reviewable=durableValueSchema.array().parse(snapshot.values).filter(v=>v.processing==='saved')
      if(reviewable.some(v=>!decisions.some(c=>c.valueId===v.id && c.decision.action!=='PENDING' && reviewFits(c,v))))
        throw new DurableInvalid('Review each saved value in this snapshot before finalizing.')
      const decisionDigest=hash(decisions)
      await client.query(`INSERT INTO extraction_runtime.finalization (id,"extractionId","snapshotVersion","feedbackVersion","decisionDigest")
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("extractionId","snapshotVersion","feedbackVersion") DO NOTHING`,[randomUUID(),id,input.snapshotVersion,input.feedbackVersion,decisionDigest])
      return {...input,decisionDigest}
    }) },
    feedback(projectId: string, targetId?: string, selectionId?:string) { return runtimeTransaction(source,async client=> {
      const owns = await client.query('SELECT id FROM public."projectContext" WHERE id=$1 AND "researcherAccountId"=$2', [projectId,owner])
      if (!owns.rowCount) throw new DurableNotFound('That Project was not found.')
      const rows=(await client.query(`SELECT c.*,e."sourceDocumentId" FROM extraction_runtime.correction c
        JOIN public.extraction e ON e.id=c."extractionId" WHERE c."projectId"=$1 ORDER BY c."feedbackVersion" DESC`,[projectId])).rows
      const target=targetId?await ownedHead(client,owner,targetId):null
      if(target && target.projectId!==projectId) throw new DurableNotFound('That target was not found in this Project.')
      if(selectionId&&!target)throw new DurableInvalid('Choose an Extraction for this input selection.')
      const selection=target?(await client.query('SELECT "schemaTree" FROM extraction_runtime.selection WHERE id=$1 AND "extractionId"=$2',[selectionId??target.selectionId,target.id])).rows[0]:null
      if(target&&!selection)throw new DurableNotFound('That input selection was not found for this Extraction.')
      const nodes=new Map<string,ReturnType<typeof parseExtractionSchema>['schemaNodes'][number]>()
      const visit=(items:ReturnType<typeof parseExtractionSchema>['schemaNodes'])=> {for(const node of items){nodes.set(node.id,node);if(node.children)visit(node.children)}}
      if(selection)visit(executionDefinition(selection.schemaTree).schemaNodes)
      const seen=new Set<string>()
      return rows.map(row=> {
        const key=row.extractionId+':'+row.valueId,active=!seen.has(key);seen.add(key)
        const node=nodes.get(row.candidate.fieldId)
        return {...row,active,targetCompatibility:!target?'not_evaluated':node&&fieldMeaning(node)===row.candidate.meaning&&adaptedCorrection(row.candidate.node,node,row.candidate.value)!==undefined?'compatible':'incompatible'}
      })
    }) },
  }
}

/** Reconciliation reads committed handoffs, enqueues deterministic identities,
 * and records the receipt. A crash between these operations re-enqueues safely. */
export async function reconcileDurableAttempts(enqueue: (attempt: {id:string;extractionId:string;workflowId:string;owner:string;sourcePin:unknown;batch:boolean;projectContextId:string;sourceDocumentId:string}) => Promise<void>, source: Pool = sharedPool, statuses?: (ids:readonly string[])=>Promise<ReadonlyMap<string,string>>) {
  if(statuses) {
    const stalled=(await source.query(`SELECT h.id,h."attemptId",h.fence,a."workflowId" FROM extraction_runtime.head h
      JOIN extraction_runtime.attempt a ON a.id=h."attemptId" WHERE a.outcome IS NULL
      AND (h."leaseUntil" IS NULL OR h."leaseUntil"<clock_timestamp()) AND h.acknowledgement IN ('RUNNING','QUEUED')`)).rows
    for(const row of stalled) {
      const captures=(await source.query('SELECT id FROM extraction_runtime.capture WHERE "extractionId"=$1',[row.id])).rows
      const ids=[row.workflowId,...captures.map(c=>`kei-call:${row.attemptId}:${c.id}`)]
      const states=await statuses(ids)
      const live=new Set(['PENDING','ENQUEUED','DELAYED'])
      if(!states.has(row.workflowId)||live.has(states.get(row.workflowId)!))continue
      if(ids.slice(1).some(id=>live.has(states.get(id)??'')||['CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(states.get(id)??'')))continue
      await runtimeTransaction(source,async client=> {
        const current=(await client.query(`SELECT * FROM extraction_runtime.head WHERE id=$1 AND "attemptId"=$2 AND fence=$3
          AND ("leaseUntil" IS NULL OR "leaseUntil"<clock_timestamp()) FOR UPDATE`,[row.id,row.attemptId,row.fence])).rows[0]
        if(!current||!['RUNNING','QUEUED'].includes(current.acknowledgement))return
        // All native workflow calls have terminated and the database lease has
        // expired. Unsaved outputs stay unfinished; no completion is fabricated.
        const snapshot = (await client.query(`SELECT coverage FROM extraction_runtime.snapshot
          WHERE "extractionId"=$1 AND version=$2`, [row.id, current.snapshotVersion])).rows[0]
        const completion = snapshot?.coverage?.finalizedAttempt
        const complete = completion?.complete === true && completion.attemptId === current.attemptId &&
          completion.generation === current.generation && completion.selectionId === current.selectionId
        const outcome = current.intent === 'STOP' ? 'STOPPED' : complete ? 'COMPLETED' : 'FAILED'
        await client.query('UPDATE extraction_runtime.capture SET "inFlight"=false WHERE "extractionId"=$1',[row.id])
        await client.query('UPDATE extraction_runtime.attempt SET outcome=$2,failure=$3 WHERE id=$1 AND outcome IS NULL',[row.attemptId,outcome,outcome==='FAILED'?{code:'execution_interrupted'}:null])
        await client.query(`UPDATE extraction_runtime.head SET acknowledgement=$2,"leaseOwner"=NULL,"leaseUntil"=NULL,
          intent=CASE WHEN intent='STOP' THEN 'STOP' ELSE 'PAUSE' END WHERE id=$1`,[row.id,outcome])
      })
    }
  }
  await runtimeTransaction(source,async client => {
    const heads = (await client.query(`SELECT * FROM extraction_runtime.head WHERE "pendingResume"
      AND acknowledgement IN ('PAUSED','FAILED') AND intent='PAUSE' AND NOT deleted AND "pendingSelectionId" IS NULL FOR UPDATE`)).rows
    for (const raw of heads) await createAttempt(client,durableHeadSchema.parse(raw))
  })
  const rows = await source.query(`SELECT a.id,a."extractionId",a."workflowId",p."researcherAccountId" AS owner,h."sourcePin",(e."batchExtractionId" IS NOT NULL) AS batch,
    p.id AS "projectContextId",s.id AS "sourceDocumentId"
    FROM extraction_runtime.dispatch d JOIN extraction_runtime.attempt a ON a.id=d.id
    JOIN extraction_runtime.head h ON h.id=a."extractionId" JOIN public.extraction e ON e.id=h.id
    JOIN public."sourceDocument" s ON s.id=e."sourceDocumentId" JOIN public."projectContext" p ON p.id=s."projectContextId"
    WHERE NOT d.received AND NOT h.deleted AND h."attemptId"=a.id AND a.outcome IS NULL
      AND h.acknowledgement NOT IN ('STOPPED','COMPLETED','FAILED','PAUSED') LIMIT 100`)
  for (const row of rows.rows) {
    await enqueue(row)
    await source.query('UPDATE extraction_runtime.dispatch SET received=true WHERE id=$1', [row.id])
  }
}

export type DurableRead = Awaited<ReturnType<ReturnType<typeof createDurableRepository>['read']>>
export type DurablePage = Awaited<ReturnType<ReturnType<typeof createDurableRepository>['page']>>
export type DurableHistory = Awaited<ReturnType<ReturnType<typeof createDurableRepository>['history']>>

export async function setFeedbackIncluded(owner:string,projectId:string,input:{id:string;expectedRevision:number;included:boolean},source:Pool=sharedPool) {
  const repository=createDurableRepository(owner,source)
  const corrections=await repository.feedback(projectId)
  const selected=corrections.find(c=>c.id===input.id)
  if(!selected) throw new DurableNotFound('That correction was not found.')
  // Inclusion edits keep the same immutable source example; they do not
  // reinterpret it against today's artifacts or drop its Evidence metadata.
  return repository.saveCorrection(selected.extractionId,selected.valueId,{...selected.decision,expectedRevision:input.expectedRevision,included:input.included},
    async()=>JSON.parse(selected.candidate.sourceContext) as Record<string,unknown>)
}

/** Tombstones retain their graph until no native writer or recoverable workflow
 * can reference it. Called by the existing DBOS reconciler, never a new worker. */
export async function collectDeletedDurableGraphs(statuses:(ids:readonly string[])=>Promise<ReadonlyMap<string,string>>,source:Pool=sharedPool,
  history?:{remove:(extractionId:string,fence:number)=>Promise<boolean>;cancelQueued:(id:string)=>Promise<void>}) {
  const rows=(await source.query(`SELECT h.id,h."projectId",h.fence FROM extraction_runtime.head h WHERE h.deleted
    AND (h."leaseUntil" IS NULL OR h."leaseUntil"<clock_timestamp())`)).rows
  let removed=0
  for(const row of rows) {
    const attempts=(await source.query('SELECT id,"workflowId" FROM extraction_runtime.attempt WHERE "extractionId"=$1',[row.id])).rows
    const captures=(await source.query('SELECT id,"reservationAttemptId","inFlight" FROM extraction_runtime.capture WHERE "extractionId"=$1',[row.id])).rows
    // An older attempt can still have native calls after its linked replacement.
    const ids=[...attempts.map(a=>a.workflowId),...attempts.flatMap(a=>captures.map(c=>`kei-call:${a.id}:${c.id}`))]
    const states=await statuses(ids),live=new Set(['PENDING','ENQUEUED','DELAYED'])
    if(history) for(const id of ids) if(states.get(id)==='ENQUEUED') await history.cancelQueued(id)
    if(ids.some(id=>live.has(states.get(id)??'')))continue
    if(!history && (ids.some(id=>['CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(states.get(id)??'')) ||
      captures.some(c=>c.inFlight&&!['SUCCESS','ERROR'].includes(states.get(`kei-call:${c.reservationAttemptId}:${c.id}`)??''))))continue
    // Delete DBOS inputs, steps and outputs while the tombstoned graph still
    // retains every identity. A crash can retry this idempotent cleanup.
    if(history&&!await history.remove(row.id,row.fence))continue
    removed+=await runtimeTransaction(source,async client=> {
      const current=(await client.query(`SELECT id FROM extraction_runtime.head WHERE id=$1 AND deleted AND fence=$2
        AND ("leaseUntil" IS NULL OR "leaseUntil"<clock_timestamp()) FOR UPDATE`,[row.id,row.fence])).rows[0]
      if(!current)return 0
      await client.query('DELETE FROM extraction_runtime.correction WHERE "extractionId"=$1',[row.id])
      await client.query('DELETE FROM extraction_runtime.head WHERE id=$1',[row.id])
      await client.query(`DELETE FROM extraction_runtime."feedbackHead" WHERE id=$1 AND NOT EXISTS (SELECT FROM public."projectContext" WHERE id=$1)
        AND NOT EXISTS (SELECT FROM extraction_runtime.head WHERE "projectId"=$1)`,[row.projectId])
      return 1
    })
  }
  return removed
}
