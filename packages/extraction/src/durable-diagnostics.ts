import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { ownedHead, runtimeTransaction } from './durable-repository.js'

export const diagnosticOptionsSchema = z.object({
  owner: z.uuid(), extraction: z.uuid(), compare: z.uuid().optional(),
  stage: z.enum(['discovery', 'inventory', 'record', 'entry', 'document', 'grounding', 'verification', 'arbitration']).default('discovery'),
  limit: z.number().int().min(1).max(5).default(3), payloads: z.boolean().default(false),
}).strict()
export type DiagnosticOptions = z.input<typeof diagnosticOptionsSchema>

export type CaptureDiagnostic = {
  id: string; key: string; generation: number; inputDigest: string | null;
  sourceDigest: string; systemDigest: string; schemaDigest: string; providerDigest: string; optionsDigest: string;
  sourceCharacters: number; examples: number; omissions: number;
  reply: { saved: boolean; places: number | null; ok: boolean | null; finish: string | null;
    inputTokens: number | null; outputTokens: number | null }
}
export type ExtractionDiagnostic = {
  id: string; status: string; intent: string; generation: number; snapshotVersion: number;
  source: { revision: string; generation: string | null }; schemaDigest: string; methodDigest: string;
  values: number; records: number;
  stages: { stage: string; captures: number; checkpointed: number }[];
  sample: { stage: string; limit: number; truncated: boolean }; calls: CaptureDiagnostic[];
}
export type DiagnosticResult = {
  summary: { extraction: ExtractionDiagnostic; comparison?: ExtractionDiagnostic; differences?: ReturnType<typeof compareDiagnostics> };
  payloads: { extraction: string; capture: string; inputDigest: string | null; request: unknown; output: unknown }[];
}

/** Compare exact saved inputs; hash source and prompts instead of disclosing them. */
export function compareDiagnostics(current: ExtractionDiagnostic, previous: ExtractionDiagnostic) {
  const changed = (field: 'sourceDigest' | 'systemDigest' | 'schemaDigest' | 'providerDigest' | 'optionsDigest') => {
    const fingerprints = (report: ExtractionDiagnostic) => [...new Set(report.calls.map(call => call[field]))].sort()
    return JSON.stringify(fingerprints(current)) !== JSON.stringify(fingerprints(previous))
  }
  const pairs = current.calls.flatMap(call => {
    const before = previous.calls.find(other => other.key === call.key)
    return before ? [{ key: call.key, inputChanged: call.inputDigest !== before.inputDigest,
      sourceChanged: call.sourceDigest !== before.sourceDigest, systemChanged: call.systemDigest !== before.systemDigest,
      schemaChanged: call.schemaDigest !== before.schemaDigest, providerChanged: call.providerDigest !== before.providerDigest,
      optionsChanged: call.optionsDigest !== before.optionsDigest,
      places: { current: call.reply.places, previous: before.reply.places } }] : []
  })
  return { sourceChanged: current.source.revision !== previous.source.revision || current.source.generation !== previous.source.generation,
    schemaChanged: current.schemaDigest !== previous.schemaDigest, methodChanged: current.methodDigest !== previous.methodDigest,
    sampledRequests: { currentCalls: current.calls.length, previousCalls: previous.calls.length,
      complete: !current.sample.truncated && !previous.sample.truncated,
      sourceChanged: changed('sourceDigest'), systemChanged: changed('systemDigest'), schemaChanged: changed('schemaDigest'),
      providerChanged: changed('providerDigest'), optionsChanged: changed('optionsDigest') },
    matchedCalls: pairs, unmatchedCurrentCalls: current.calls.filter(call => !pairs.some(pair => pair.key === call.key)).map(call => call.key) }
}

async function metadata(client: PoolClient, head: Awaited<ReturnType<typeof ownedHead>>, stage: string, limit: number): Promise<ExtractionDiagnostic> {
  const selection = (await client.query(`SELECT "schemaHash", extraction_runtime.content_hash(resolved) AS "methodDigest"
    FROM extraction_runtime.selection WHERE id=$1 AND "extractionId"=$2`, [head.selectionId, head.id])).rows[0]
  const saved = (await client.query(`SELECT jsonb_array_length(s.values) AS values,
    (SELECT count(DISTINCT value->>'recordId')::int FROM jsonb_array_elements(s.values) value) AS records
    FROM extraction_runtime.snapshot s WHERE s."extractionId"=$1 AND s.version=$2`, [head.id, head.snapshotVersion])).rows[0]
  const stages = (await client.query(`SELECT left(coalesce(c.descriptor->>'stage','unknown'),32) AS stage,
    count(*)::int AS captures, count(o.id)::int AS checkpointed FROM extraction_runtime.capture c
    LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id WHERE c."extractionId"=$1
    GROUP BY 1 ORDER BY 1 LIMIT 16`, [head.id])).rows
  const calls = (await client.query<CaptureDiagnostic>(`SELECT c.id,c."unitKey" AS key,c.generation,i.digest AS "inputDigest",
    encode(sha256(convert_to(coalesce(i.request#>>'{body,user}',''),'UTF8')),'hex') AS "sourceDigest",
    encode(sha256(convert_to(coalesce(i.request#>>'{body,system}',''),'UTF8')),'hex') AS "systemDigest",
    extraction_runtime.content_hash(coalesce(i.request#>'{body,schema}','null'::jsonb)) AS "schemaDigest",
    extraction_runtime.content_hash(coalesce(i.request->'provider','null'::jsonb)) AS "providerDigest",
    extraction_runtime.content_hash(coalesce(i.request#>'{body,httpRequest}','{}'::jsonb)-'messages'-'model') AS "optionsDigest",
    length(coalesce(i.request#>>'{body,user}','')) AS "sourceCharacters",
    coalesce(jsonb_array_length(i.request->'examples'),0) AS examples,coalesce(jsonb_array_length(i.request->'omissions'),0) AS omissions,
    jsonb_build_object('saved',coalesce(o.output,f.output) IS NOT NULL,
      'places',CASE WHEN jsonb_typeof(coalesce(o.output,f.output)#>'{parsed,places}')='array'
        THEN jsonb_array_length(coalesce(o.output,f.output)#>'{parsed,places}') ELSE NULL END,
      'ok',coalesce(o.output,f.output)#>'{calls,-1,ok}','finish',coalesce(o.output,f.output)#>'{calls,-1,finish}',
      'inputTokens',coalesce(o.output,f.output)#>'{calls,-1,input_tokens}',
      'outputTokens',coalesce(o.output,f.output)#>'{calls,-1,output_tokens}') AS reply
    FROM extraction_runtime.capture c LEFT JOIN extraction_runtime.input i ON i.id=c.id
    LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id
    LEFT JOIN extraction_runtime."callFailure" f ON f."captureId"=c.id AND f."attemptId"=$4
    WHERE c."extractionId"=$1 AND c.descriptor->>'stage'=$2
    ORDER BY c.generation DESC,c."unitKey" LIMIT $3`, [head.id, stage, limit, head.attemptId])).rows
  return { id: head.id, status: head.acknowledgement, intent: head.intent, generation: head.generation,
    snapshotVersion: head.snapshotVersion, source: { revision: head.sourceRevisionId,
      generation: typeof head.sourcePin.generation === 'string' ? head.sourcePin.generation : null },
    schemaDigest: selection.schemaHash, methodDigest: selection.methodDigest,
    values: saved?.values ?? 0, records: saved?.records ?? 0, stages,
    sample: { stage, limit, truncated: (stages.find(row => row.stage === stage)?.captures ?? 0) > calls.length }, calls }
}

/** Operator diagnostics use the normal owner gate and a repeatable, read-only
 * transaction. Default queries select metadata only, never whole histories. */
export async function readDurableDiagnostics(pool: Pool, input: DiagnosticOptions): Promise<DiagnosticResult> {
  const options = diagnosticOptionsSchema.parse(input)
  return runtimeTransaction(pool, async client => {
    await client.query('SET TRANSACTION READ ONLY')
    const head = await ownedHead(client, options.owner, options.extraction)
    const previousHead = options.compare ? await ownedHead(client, options.owner, options.compare) : null
    const extraction = await metadata(client, head, options.stage, options.limit)
    const comparison = previousHead ? await metadata(client, previousHead, options.stage, options.limit) : undefined
    const payloads: DiagnosticResult['payloads'] = []
    if (options.payloads) {
      for (const report of [extraction, ...(comparison ? [comparison] : [])]) {
        const rows = (await client.query(`SELECT c.id AS capture,i.digest AS "inputDigest",i.request,coalesce(o.output,f.output) AS output
          FROM extraction_runtime.capture c LEFT JOIN extraction_runtime.input i ON i.id=c.id
          LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id
          LEFT JOIN extraction_runtime."callFailure" f ON f."captureId"=c.id AND f."attemptId"=$3
          WHERE c."extractionId"=$1 AND c.id=ANY($2::uuid[])`, [report.id, report.calls.map(call => call.id),
            report.id === head.id ? head.attemptId : previousHead?.attemptId])).rows
        payloads.push(...rows.map(row => ({ extraction: report.id, ...row })))
      }
    }
    return { summary: { extraction, ...(comparison ? { comparison, differences: compareDiagnostics(extraction, comparison) } : {}) }, payloads }
  }, 'REPEATABLE READ')
}
