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
import type { ChatHistory, ChatView } from '../shared/schemaChat.contract.js'
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
/** The message, the chat before it, and where it was said (ADR 0040), which hints whether it is about a field or a value. */
export type CorrectionRequest = Readonly<{ message: string; history: ChatHistory; view?: ChatView | null }>
export type CorrectionCall = Readonly<{ temperature?: number; signal?: AbortSignal }>

/** The most of the value table one request carries; values past it are said to be left out and cannot be changed. */
export const VALUE_TABLE_BUDGET = 40_000

const INSTRUCTIONS =
  'Report what the researcher\'s message asks about the extracted results. Return only one JSON object, with no Markdown fences or commentary.'

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

/** `current` is what Results shows for a value now: the model's, or the researcher's edit (a missing one filled in). */
const currentValue = (value: CorrectableValue) => reviewedValue(value) ?? null
/** A value the model found nothing for: it can be filled in, never rejected (`saveCorrection`). */
const missing = (value: CorrectableValue) => value.processing === 'absent'

/**
 * The values the model reads, one JSON line each under a short alias (`v1`, `v2`…) that the reply names, so the model
 * never handles a value's own ID. Saved values come first, then the missing ones (marked `"missing":true`), each in
 * result order; values past `budget` are left out and counted. Values not read yet cannot be changed and are not listed.
 */
export function valueTable(values: readonly CorrectableValue[], budget = VALUE_TABLE_BUDGET) {
  const aliases = new Map<string, CorrectableValue>()
  const lines: string[] = []
  let length = 0
  const correctable = [...values.filter((value) => value.processing === 'saved'), ...values.filter(missing)]
  for (const value of correctable) {
    const alias = `v${aliases.size + 1}`
    const [where, field] = valueLabel(value).split(' · ')
    const quote = quoteOf(value)
    const line = JSON.stringify({
      id: alias, where, field, type: typeText(value.node),
      ...(value.node.description ? { description: value.node.description } : {}),
      value: currentValue(value),
      ...(missing(value) ? { missing: true } : {}),
      ...(value.correction ? { decision: value.correction.decision.action } : {}),
      ...(quote ? { quote } : {}),
    })
    if (length + line.length > budget) break
    aliases.set(alias, value)
    lines.push(line)
    length += line.length + 1
  }
  // Every field the values were read with, listed or not: what a request can name although no listed value has it.
  const fields = new Map(values.map((value) => [value.node.name, value.node] as const))
  return { aliases, fields, text: lines.join('\n'), omitted: correctable.length - aliases.size }
}

/** The template's fields as the model is told them, by name: each top-level field the result's values were read with. */
function fieldsText(fields: ReadonlyMap<string, SchemaNode>): string {
  return [...fields.values()].map((node) => JSON.stringify({ field: node.name, type: typeText(node), ...(node.description ? { description: node.description } : {}) })).join('\n')
}

const VIEW_HINT: Record<ChatView, string> = {
  results: 'The researcher said this while looking at the extracted results.',
  template: 'The researcher said this while looking at the template: a message there about a field is more likely about how the field is read than about one value.',
  chat: 'The researcher said this in the chat.',
}

/**
 * The request for the facts of a message about the results (ADR 0043): for each thing it asks, which value or field it
 * is about, whether it is about one value or how a field is read, and the value it should hold and where that comes
 * from. The model reports; `routeFacts` decides what Studio does with each.
 */
export function resultCorrectionPrompt(table: ReturnType<typeof valueTable>, { message, history, view }: CorrectionRequest): string {
  const conversation = chatHistoryText(history)
  return `${conversation ? `${conversation}\n\n` : ''}${view ? `${VIEW_HINT[view]}\n` : ''}The researcher's latest chat message:
${message.trim()}

The template's fields follow, one JSON object per line.
FIELDS:
${fieldsText(table.fields) || '(none)'}

The extracted values of this document's results follow, one JSON object per line: "id" names the value, "where" its record (or the whole document), "field" its field, "type" the field's type, "value" the value as it stands now (null when empty), "decision" the researcher's last decision on it, if any, "missing" true when the extraction found no value for it, and "quote" the source text it was read from, if any.
VALUES:
${table.text || '(none)'}${table.omitted ? `\n(${table.omitted} more values are not listed; they cannot be changed here.)` : ''}

Report the facts of each thing the message asks about the results, one item each; do not decide what to do about it. Each item has:
- "about": what it asks, in a few words, in the language of the message.
- "value": the "id" of the listed value it is about; null when no listed value is (a record or entry the results do not have, or a field the template lacks).
- "field": the name of the template field it concerns, as FIELDS names it; null when no field in FIELDS is for it.
- "scope": "value" when particular values are wrong; "field" when the field is read wrongly in general (the same mistake in all or most of its values) or the message says how the field is to be read from now on.
- "remove": true when the message says the value should not be there at all; otherwise false.
- "desired": the value it should hold, as the field's type would hold it if it can (a list for a list field, an object with the field's parts for an object field), else as the message or the source says it; null when you do not know it.
- "from": "message" when the message gives that value, "source" when you read it from the source document, null when "desired" is null.
- "quote": when "from" is "source", the text of the source the value is read from, copied exactly; otherwise null.
- "template": when FIELDS has no field for it, or "scope" is "field", one instruction for the template, in the language of the message, naming the fields to add, change or remove and saying for each how it is to be read from the document; otherwise null.
Never report a value the message does not name or clearly mean. Return only {"items":[{"about":"…","value":"<id>","field":"<name>","scope":"value","remove":false,"desired":<value>,"from":"message","quote":null,"template":null}],"reply":"<one or two sentences to the researcher, in the language of their message>"}. When it is unclear what the message is about, return no items and ask in "reply".`
}

/** The instruction for a template change when a value the researcher wants cannot be held by its field and the model
 *  named no template change itself: the message, said as what the template must be able to hold. */
export const misfitTemplateChange = (message: string) =>
  `Change the template so that the extraction can hold what the researcher asked for: “${message.trim()}”. Say in each changed field's description how it is to be read.`

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Text as it is compared to find a quote in the source: lower case, without Markdown marks, with its spaces folded. */
const plain = (text: string) => text.toLowerCase().replace(/[*_`#|>]/g, ' ').replace(/\s+/g, ' ').trim()
/** A quote the model read a value from is in the source: else the value is not taken as read. */
export const quoted = (quote: unknown, markdown: string) =>
  typeof quote === 'string' && plain(quote).length >= 3 && plain(markdown).includes(plain(quote))
const text = (field: unknown) => typeof field === 'string' && field.trim() ? field.trim() : null

/** What the model reports of one thing the message asks (ADR 0043). */
type Fact = Readonly<{ about: string | null; value: unknown; field: string | null; scope: unknown; remove: unknown; desired: unknown;
  from: unknown; quote: unknown; template: string | null }>

/**
 * What Studio does with each fact (ADR 0043), whatever the message's wording:
 * - no template field for it, or a field read wrongly in general, or a value its field cannot hold: a template change;
 * - a listed value whose wanted value is known (given by the message, or read from the source with a quote found in
 *   it) and fits: a change to that value, or its rejection;
 * - otherwise, the template holds it but no listed value can take it (a record the results do not have, a value whose
 *   right value was not found): a new run (ADR 0042).
 * A template change goes first: it is extracted again anyway, so no run is offered beside it.
 */
export function routeFacts(
  facts: readonly Fact[],
  table: Pick<ReturnType<typeof valueTable>, 'aliases' | 'fields'>,
  markdown: string,
  message?: string,
) {
  const corrections: ProposedCorrection[] = []
  const dropped: string[] = []
  const templates: string[] = []
  const reruns: string[] = []
  const toTemplate = (fact: Fact, fallback: string) => { const instruction = fact.template ?? fallback; if (!templates.includes(instruction)) templates.push(instruction) }
  for (const fact of facts) {
    const alias = typeof fact.value === 'string' ? fact.value.trim() : null
    const value = alias ? table.aliases.get(alias) : undefined
    if (alias && !value) { dropped.push(`A change to ${JSON.stringify(alias)}, which is not a listed value.`); continue }
    const node = value?.node ?? (fact.field ? table.fields.get(fact.field) : undefined)
    const asked = fact.about ?? message?.trim() ?? 'the request'
    if (!node) { toTemplate(fact, misfitTemplateChange(message ?? asked)); continue }
    if (fact.scope === 'field') { toTemplate(fact, `Change how the field "${node.name}" is read: ${asked}. Say in its description how it is to be read.`); continue }
    const label = value ? valueLabel(value) : null
    if (value && corrections.some((correction) => correction.valueId === value.id)) { dropped.push(`A second change to ${label}.`); continue }
    const current = value ? currentValue(value) : null
    const expectedRevision = value ? (value.correction ?? value.historicalCorrection)?.revision ?? 0 : 0
    if (value && fact.remove === true) {
      if (missing(value)) {
        if (current !== null) dropped.push(`${label}: to remove a value you filled in, use Undo in Results.`)
        continue
      }
      if (value.correction?.decision.action === 'REJECTED') continue
      corrections.push({ valueId: value.id, label: label!, action: 'REJECTED', current, expectedRevision, reason: fact.about })
      continue
    }
    const wanted = fact.desired !== undefined && fact.desired !== null
    const known = wanted && (fact.from === 'message' || (fact.from === 'source' && quoted(fact.quote, markdown)))
    if (known && !correctionValueFits(node, fact.desired)) { toTemplate(fact, misfitTemplateChange(message ?? asked)); continue }
    if (value && known) {
      if (same(fact.desired, current)) continue
      corrections.push({ valueId: value.id, label: label!, action: 'EDITED', current, value: fact.desired, expectedRevision, reason: fact.about })
      continue
    }
    // The template holds it, yet no listed value can take it.
    const reason = value ? `${label}: its right value was not found in the source shown to the chat.` : `Not in the results: ${asked}.`
    if (!reruns.includes(reason)) reruns.push(reason)
  }
  const templateChange = templates.length ? templates.join('\n').slice(0, 2000) : null
  return { corrections, dropped, templateChange, rerun: templateChange === null && reruns.length ? reruns.join(' ').slice(0, 500) : null }
}

/** The proposal a reply makes of a result: its facts (ADR 0043), routed by `routeFacts`. */
export async function correctionProposalOf(
  response: string,
  result: Pick<ResultToCorrect, 'extractionId' | 'snapshotVersion' | 'markdown'>,
  table: Pick<ReturnType<typeof valueTable>, 'aliases' | 'fields'>,
  /** The researcher's message: what the template must hold when a wanted value does not fit its field. */
  message?: string,
): Promise<ResultCorrectionProposal> {
  const parsed = await parseUnknownJson(response, 'Model returned invalid JSON.')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new ApiError(502, 'invalid_model_output', 'The model returned no corrections.')
  const { items, reply } = parsed as Record<string, unknown>
  const facts: Fact[] = (Array.isArray(items) ? items : []).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const { about, value, field, scope, remove, desired, from, quote, template } = item as Record<string, unknown>
    return [{ about: text(about), value, field: text(field), scope, remove, desired, from, quote, template: text(template) }]
  })
  return {
    extractionId: result.extractionId,
    snapshotVersion: result.snapshotVersion,
    reply: text(reply),
    ...routeFacts(facts, table, result.markdown, message),
  }
}

/** One request on a general route: the values and the message in the guidance, the source (excerpted past
 *  `EXCERPT_THRESHOLD`) as the document. Exported for the live evaluation of its routing. */
export async function proposeCorrectionsOnRoute(
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
  return correctionProposalOf(response, result, table, request.message)
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
