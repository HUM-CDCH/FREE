import type { SourcePageSpan } from 'db'
import { ApiError } from './_http.js'
import {
  executeSchemaSuggestion,
  resolveModelTarget,
  type ModelCaller,
  type ModelDependencies,
} from './_model_execution.js'
import type { ExecutionTarget, GeneralExecutionTarget } from './_provider.js'
import { chatHistoryText, schemaSourceExcerpts } from './_schema.js'
import { answerOf, suggestOnRoute, type SchemaModelInput } from './_schema_suggestion.js'
import { classifyChatMessage } from './_chat_intent.js'
import { traceModelCall } from '../server/tracing.js'
import type { ChatHistory, ChatRequestAction, ChatWhere } from '../shared/schemaChat.contract.js'

/** A schema chat message: the researcher's text, the chat before it, after the first schema that schema as the model
 *  reads it, what the chat offers beside the message (its step's title and question), and where it was said (ADR 0040). */
export type SchemaChatQuestion = Readonly<{ message: string; context: string | null; history: ChatHistory; offer?: string | null; where?: ChatWhere | null }>
/** What a chat message asks Studio to do instead of an answer or a change: nothing (`none`), or a request with what a
 *  template asked for should hold (ADR 0034). */
export type ChatRequest = { readonly action: 'none' } | { readonly action: ChatRequestAction; readonly focus: string | null }
export type SchemaChatCall = Readonly<{ temperature?: number; signal?: AbortSignal }>
type ChatSource = Readonly<{ markdown: string; pageSpans?: readonly SourcePageSpan[] }>

const ANSWER_INSTRUCTIONS =
  'Answer the researcher from the supplied source document. Return only one JSON object, with no Markdown fences or commentary.'
const NO_SOURCE = 'No source document accompanies this message.'

function questionText({ message, context, history }: SchemaChatQuestion): string {
  const conversation = chatHistoryText(history)
  return `${context ? `${context}\n\n` : ''}${conversation ? `${conversation}\n\n` : ''}The researcher's latest chat message:\n${message.trim()}`
}

/**
 * The routes of a schema chat: the Schema Suggestion Route, and the general route that answers questions — the same
 * route, or the Interaction Route when Schema Suggestion is NuExtract, which only generates templates. `answer` is null
 * when NuExtract has no Interaction Route beside it, and the chat then only gives instructions.
 */
export async function schemaChatRoutes(
  caller: ModelCaller,
  temperature: number | undefined,
  dependencies: ModelDependencies = {},
): Promise<{ suggestion: ExecutionTarget; answer: GeneralExecutionTarget | null }> {
  const suggestion = await resolveModelTarget('schema-suggestion', temperature, undefined, caller, dependencies)
  if (suggestion.profile === 'general') return { suggestion, answer: suggestion }
  try {
    const answer = await resolveModelTarget('schema-edit', temperature, undefined, caller, dependencies)
    return { suggestion, answer: answer.profile === 'general' ? answer : null }
  } catch (error) {
    // A missing or unusable Assistant model leaves the chat as it was: instructions only.
    if (error instanceof ApiError && ['invalid_model_config', 'unsupported_temperature'].includes(error.code))
      return { suggestion, answer: null }
    throw error
  }
}

async function ask(target: GeneralExecutionTarget, guidance: string, text: string, call: SchemaChatCall): Promise<string> {
  const { response } = await executeSchemaSuggestion(target, {
    instructions: ANSWER_INSTRUCTIONS,
    guidance,
    documentParts: [{ type: 'text', text }],
    temperature: call.temperature,
    signal: call.signal,
  })
  return response
}

/**
 * What a chat message asks for, read first (`classifyChatMessage`) whatever the state, then done: a question's answer,
 * or a request for Studio; null for a change to the schema (before the first schema, an instruction for it). The model
 * answers from the source as Schema Suggestion reads it (excerpted past `EXCERPT_THRESHOLD`); a long source's question
 * is then answered again from every window (`answerFromWindow`).
 */
export async function readChatMessage(
  target: GeneralExecutionTarget,
  source: ChatSource | null,
  question: SchemaChatQuestion,
  call: SchemaChatCall = {},
): Promise<string | ChatRequest | null> {
  const { intent, focus } = await classifyChatMessage(target, question, call)
  if (intent === 'edit') return null
  if (intent === 'none') return { action: 'none' }
  if (intent !== 'question') return { action: intent, focus }
  const text = source ? schemaSourceExcerpts(source.markdown, source.pageSpans).text : NO_SOURCE
  const response = await ask(target, `${questionText(question)}

Answer that message from the source document and return only {"answer":"<your answer>"}. Answer in the language of the message, concisely, and say so when the document does not contain the answer.`, text, call)
  // A question with no answer is read as it was before it was classified: a change, or an instruction.
  return answerOf(response)
}

/** What one window of a long source contributes to the answer; empty when it has nothing relevant. */
export async function answerFromWindow(
  caller: ModelCaller,
  window: { text: string; index: number; count: number },
  question: SchemaChatQuestion,
  call: SchemaChatCall = {},
  dependencies: ModelDependencies = {},
): Promise<string> {
  const response = await ask(await answerRoute(caller, call, dependencies), `${questionText(question)}

The supplied text is part ${window.index} of ${window.count} of the source document. Answer the message from this part only: give every fact, item or count in it that the answer needs, so the answers of all parts can be combined into one. Answer in the language of the question and return only {"answer":"<your answer>"}; return {"answer":""} when this part has nothing relevant.`, window.text, call)
  return (await answerOf(response)) ?? ''
}

/** One answer for the whole source from its windows' answers, in source order. */
export async function combineWindowAnswers(
  caller: ModelCaller,
  answers: readonly string[],
  question: SchemaChatQuestion,
  call: SchemaChatCall = {},
  dependencies: ModelDependencies = {},
): Promise<string> {
  const text = answers.map((answer, index) => `PART ${index + 1}:\n${answer || '(nothing relevant)'}`).join('\n\n')
  const response = await ask(await answerRoute(caller, call, dependencies), `${questionText(question)}

The supplied text holds the answers to that message from each consecutive part of one source document, in order. Combine them into one answer for the whole document: add up counts, keep every item once, and say so when no part answers it. Answer in the language of the question, concisely, and return only {"answer":"<your answer>"}.`, text, call)
  const answer = await answerOf(response)
  if (answer === null) throw new ApiError(502, 'invalid_model_output', 'The model returned no answer.')
  return answer
}

async function answerRoute(caller: ModelCaller, call: SchemaChatCall, dependencies: ModelDependencies) {
  const { answer } = await schemaChatRoutes(caller, call.temperature, dependencies)
  if (!answer) throw new ApiError(409, 'invalid_model_config', 'No Assistant model is configured to answer questions.')
  return answer
}

/** A message before the first schema: its answer when it asks a question, a request for Studio, or null when it is an
 *  instruction for generation (every message is one with nothing to read it). */
export function answerSchemaChat(
  caller: ModelCaller,
  source: ChatSource,
  message: Pick<SchemaChatQuestion, 'message' | 'history' | 'offer'>,
  call: SchemaChatCall = {},
  dependencies: ModelDependencies = {},
): Promise<string | ChatRequest | null> {
  return traceModelCall('schema-chat', async () => {
    const { answer } = await schemaChatRoutes(caller, call.temperature, dependencies)
    return answer ? readChatMessage(answer, source, { ...message, context: null }, call) : null
  })
}

/**
 * An edit chat message's reply: the answer when it asks a question, a request for Studio, or the revised schema. The
 * general route (the Schema Suggestion Route, or the Interaction Route beside NuExtract) reads the message first; a
 * change then runs on the Schema Suggestion Route. With NuExtract and nothing beside it, every message is a change.
 */
export function respondToSchemaEdit(
  caller: ModelCaller,
  input: SchemaModelInput,
  question: SchemaChatQuestion,
  dependencies: ModelDependencies = {},
): Promise<Awaited<ReturnType<typeof suggestOnRoute>> | { readonly answer: string } | ChatRequest> {
  return traceModelCall('schema-chat', async () => {
    const { suggestion, answer } = await schemaChatRoutes(caller, input.temperature, dependencies)
    const read = answer && await readChatMessage(answer, input.document.markdown
      ? { markdown: input.document.markdown, pageSpans: input.document.pageSpans }
      : null, question, input)
    if (typeof read === 'string') return { answer: read }
    return read ?? suggestOnRoute(suggestion, input, dependencies)
  }, (result) => ('answer' in result || 'action' in result ? result : result.template))
}
