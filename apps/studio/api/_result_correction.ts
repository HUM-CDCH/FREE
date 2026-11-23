import { correctionValueFits } from 'extraction/durable'
import type { DurablePage } from 'extraction/durable-types'
import { reviewedValue } from 'extraction/value-disagreement'
import type { SchemaNode } from 'extraction/schema'
import { ApiError } from './_http.js'
import { executeSchemaSuggestion, type ModelCaller, type ModelDependencies } from './_model_execution.js'
import { parseUnknownJson } from './_model_output.js'
import type { GeneralExecutionTarget } from './_provider.js'
import { chatHistoryText, schemaSourceExcerpts } from './_schema.js'
import { schemaChatRoutes } from './_schema_chat.js'
import { traceModelCall } from '../server/tracing.js'
import type { ChatHistory } from '../shared/schemaChat.contract.js'
import type { ProposedCorrection, ResultCorrectionProposal } from '../shared/resultCorrection.contract.js'

/** One saved value of a result page, as Results reads it: the model's value, with the researcher's latest decision. */
export type CorrectableValue = DurablePage['values'][number]
/** The result a chat message corrects: one pinned snapshot's values and the Markdown of the source they were read from. */
export type ResultToCorrect = Readonly<{
  extractionId: string
  snapshotVersion: number
  values: readonly CorrectableValue[]
  markdown: string
}>
export type CorrectionRequest = Readonly<{ message: string; history: ChatHistory }>
export type CorrectionCall = Readonly<{ temperature?: number; signal?: AbortSignal }>

/** The most of the value table one request carries; values past it are said to be left out and cannot be changed. */
export const VALUE_TABLE_BUDGET = 40_000

const INSTRUCTIONS =
  'Propose corrections to the extracted values the researcher names. Return only one JSON object, with no Markdown fences or commentary.'

/** Where a value is, as Results shows it: a Catalog record by its number (`Record 3`), or the document for an Article. */
export function valueLabel(value: Pick<CorrectableValue, 'path' | 'node'>): string {
  const { path } = value
  const inRecord = path[0] === 'records' && typeof path[1] === 'number'
  const field = (inRecord ? path.slice(2) : path).map((part) => typeof part === 'number' ? `#${part + 1}` : part).join(' › ')
  return `${inRecord ? `Record ${(path[1] as number) + 1}` : 'Document'} · ${field || value.node.name}`
}

/** A field's type as the model is told it: a list's item type, a choice's allowed values, an object's parts. */
function typeText(node: SchemaNode): string {
  if (node.children) return `${node.type === 'array' ? 'list of objects' : 'object'} with ${node.children.map((child) => `${child.name} (${typeText(child)})`).join(', ')}`
  if (node.type === 'array') return `list of ${node.itemType}`
  if (node.allowedValues) return `one of ${node.allowedValues.map((allowed) => JSON.stringify(allowed)).join(', ')}`
  return node.type
}

function quoteOf(value: CorrectableValue): string | null {
  const quotes = value.evidence.flatMap(({ producer }) => {
    const raw = 'raw' in producer ? producer.raw : producer.location?.raw
    return raw?.trim() ? [raw.trim().slice(0, 200)] : []
  })
  return quotes.length ? quotes.join(' … ') : null
}

/** Only a saved value can be corrected (`saveCorrection`); `current` is what Results shows for it now. */
const currentValue = (value: CorrectableValue) => reviewedValue(value) ?? null

/**
 * The values the model reads, one JSON line each under a short alias (`v1`, `v2`…) that the reply names, so the model
 * never handles a value's own ID. Values past `budget` are left out, in result order, and counted.
 */
export function valueTable(values: readonly CorrectableValue[], budget = VALUE_TABLE_BUDGET) {
  const aliases = new Map<string, CorrectableValue>()
  const lines: string[] = []
  let length = 0
  for (const value of values) {
    if (value.processing !== 'saved') continue
    const alias = `v${aliases.size + 1}`
    const [where, field] = valueLabel(value).split(' · ')
    const quote = quoteOf(value)
    const line = JSON.stringify({
      id: alias, where, field, type: typeText(value.node),
      ...(value.node.description ? { description: value.node.description } : {}),
      value: currentValue(value),
      ...(value.correction ? { decision: value.correction.decision.action } : {}),
      ...(quote ? { quote } : {}),
    })
    if (length + line.length > budget) break
    aliases.set(alias, value)
    lines.push(line)
    length += line.length + 1
  }
  const saved = values.filter((value) => value.processing === 'saved').length
  return { aliases, text: lines.join('\n'), omitted: saved - aliases.size }
}

export function resultCorrectionPrompt(table: ReturnType<typeof valueTable>, { message, history }: CorrectionRequest): string {
  const conversation = chatHistoryText(history)
  return `${conversation ? `${conversation}\n\n` : ''}The researcher's latest chat message:
${message.trim()}

The extracted values of this document's results follow, one JSON object per line: "id" names the value, "where" its record (or the whole document), "field" its field, "type" the field's type, "value" the value as it stands now (null when empty), "decision" the researcher's last decision on it, if any, and "quote" the source text it was read from, if any.
VALUES:
${table.text || '(none)'}${table.omitted ? `\n(${table.omitted} more values are not listed; they cannot be changed here.)` : ''}

Change only the values the researcher's message names or clearly means. For each, give its "id" and either "action":"edit" with the corrected value in "value", of the field's type (a list for a list field, an object with the field's parts for an object field), or "action":"reject" when the researcher says the value should not be there at all. Take the corrected value from the message, or from the source document when the message only says the value is wrong. Never change a value the message does not name.
Return only {"corrections":[{"id":"<id>","action":"edit","value":<value>,"reason":"<why, in a few words>"}],"reply":"<one or two sentences to the researcher, in the language of their message>"}. When the message names no value you can find, or it is unclear which one is meant, return no corrections and ask in "reply".`
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The proposal a reply makes of a result: each change to a listed value, checked as `saveCorrection` will check it (an
 * edit must fit its field), and each one left out, said. A change that leaves a value as it is is no change.
 */
export async function correctionProposalOf(
  response: string,
  result: Pick<ResultToCorrect, 'extractionId' | 'snapshotVersion'>,
  aliases: ReadonlyMap<string, CorrectableValue>,
): Promise<ResultCorrectionProposal> {
  const parsed = await parseUnknownJson(response, 'Model returned invalid JSON.')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new ApiError(502, 'invalid_model_output', 'The model returned no corrections.')
  const { corrections: raw, reply } = parsed as Record<string, unknown>
  const corrections: ProposedCorrection[] = []
  const dropped: string[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, action, value: proposed, reason } = entry as Record<string, unknown>
    const value = typeof id === 'string' ? aliases.get(id.trim()) : undefined
    if (!value) { dropped.push(`A change to ${JSON.stringify(id)}, which is not a listed value.`); continue }
    const label = valueLabel(value)
    if (corrections.some((correction) => correction.valueId === value.id)) { dropped.push(`A second change to ${label}.`); continue }
    const current = currentValue(value)
    const why = typeof reason === 'string' && reason.trim() ? reason.trim() : null
    const expectedRevision = (value.correction ?? value.historicalCorrection)?.revision ?? 0
    if (action === 'reject') {
      if (value.correction?.decision.action === 'REJECTED') continue
      corrections.push({ valueId: value.id, label, action: 'REJECTED', current, expectedRevision, reason: why })
    } else if (action === 'edit') {
      if (proposed === undefined || !correctionValueFits(value.node, proposed)) {
        dropped.push(`${label}: ${JSON.stringify(proposed ?? null)} does not fit its field (${typeText(value.node)}).`)
        continue
      }
      if (same(proposed, current)) continue
      corrections.push({ valueId: value.id, label, action: 'EDITED', current, value: proposed, expectedRevision, reason: why })
    } else dropped.push(`${label}: ${JSON.stringify(action ?? null)} is neither an edit nor a rejection.`)
  }
  return {
    extractionId: result.extractionId,
    snapshotVersion: result.snapshotVersion,
    corrections,
    reply: typeof reply === 'string' && reply.trim() ? reply.trim() : null,
    dropped,
  }
}

/** One request on a general route: the values and the message in the guidance, the source (excerpted past
 *  `EXCERPT_THRESHOLD`) as the document. */
async function proposeCorrectionsOnRoute(
  target: GeneralExecutionTarget,
  result: ResultToCorrect,
  request: CorrectionRequest,
  call: CorrectionCall = {},
): Promise<ResultCorrectionProposal> {
  const table = valueTable(result.values)
  const { response } = await executeSchemaSuggestion(target, {
    instructions: INSTRUCTIONS,
    guidance: resultCorrectionPrompt(table, request),
    documentParts: [{ type: 'text', text: schemaSourceExcerpts(result.markdown).text }],
    temperature: call.temperature,
    signal: call.signal,
  })
  return correctionProposalOf(response, result, table.aliases)
}

/**
 * A chat message's proposed corrections of a result (ADR 0035), on the chat's general route: the Schema Suggestion
 * Route, or the Interaction Route beside NuExtract, which only generates templates. Nothing is saved here.
 */
export function proposeResultCorrections(
  caller: ModelCaller,
  result: ResultToCorrect,
  request: CorrectionRequest,
  call: CorrectionCall = {},
  dependencies: ModelDependencies = {},
): Promise<ResultCorrectionProposal> {
  return traceModelCall('result-correction', async () => {
    const { answer } = await schemaChatRoutes(caller, call.temperature, dependencies)
    if (!answer) throw new ApiError(409, 'invalid_model_config', 'No Assistant model is configured to change results.')
    return proposeCorrectionsOnRoute(answer, result, request, call)
  })
}
