import type { SourcePageSpan } from 'db'
import { ApiError } from './_http.js'
import {
  executeSchemaSuggestion,
  resolveModelTarget,
  type ModelCaller,
  type ModelDependencies,
} from './_model_execution.js'
import type { ExecutionTarget, GeneralExecutionTarget } from './_provider.js'
import { schemaSourceExcerpts } from './_schema.js'
import { answerOf, suggestOrAnswer, type SchemaModelInput } from './_schema_suggestion.js'
import { traceModelCall } from '../server/tracing.js'

/** A schema chat message: the researcher's text and, after the first schema, that schema as the model reads it. */
export type SchemaChatQuestion = Readonly<{ message: string; context: string | null }>
export type SchemaChatCall = Readonly<{ temperature?: number; signal?: AbortSignal }>
type ChatSource = Readonly<{ markdown: string; pageSpans?: readonly SourcePageSpan[] }>

const ANSWER_INSTRUCTIONS =
  'Answer the researcher from the supplied source document. Return only one JSON object, with no Markdown fences or commentary.'
const NO_SOURCE = 'No source document accompanies this message.'

function questionText({ message, context }: SchemaChatQuestion): string {
  return `${context ? `${context}\n\n` : ''}The researcher's chat message:\n${message.trim()}`
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
 * The answer when the message asks a question, or null when it gives an instruction for the schema. The model reads
 * the source as Schema Suggestion does (excerpted past `EXCERPT_THRESHOLD`); a long source's question is then answered
 * again from every window (`answerFromWindow`).
 */
export async function answerIfQuestion(
  target: GeneralExecutionTarget,
  source: ChatSource | null,
  question: SchemaChatQuestion,
  call: SchemaChatCall = {},
): Promise<string | null> {
  const text = source ? schemaSourceExcerpts(source.markdown, source.pageSpans).text : NO_SOURCE
  return answerOf(await ask(target, `${questionText(question)}

If that message asks a question (about the source document or the extraction schema) instead of giving an instruction for generating or changing the schema, answer it from the source document and return only {"answer":"<your answer>"}. Answer in the language of the question, concisely, and say so when the document does not contain the answer.
Otherwise return only {"answer":null}.`, text, call))
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

/** A message before the first schema: its answer when it asks a question, or null when it is an instruction. */
export function answerSchemaChat(
  caller: ModelCaller,
  source: ChatSource,
  message: string,
  call: SchemaChatCall = {},
  dependencies: ModelDependencies = {},
): Promise<string | null> {
  return traceModelCall('schema-chat', async () => {
    const { answer } = await schemaChatRoutes(caller, call.temperature, dependencies)
    return answer ? answerIfQuestion(answer, source, { message, context: null }, call) : null
  })
}

/**
 * An edit chat message's reply: the answer when it asks a question, or the revised schema. On a general route one
 * Schema Suggestion request does both; NuExtract only generates templates, so the Interaction Route answers first and
 * a message that is not a question then runs on NuExtract.
 */
export function respondToSchemaEdit(
  caller: ModelCaller,
  input: SchemaModelInput,
  question: SchemaChatQuestion,
  dependencies: ModelDependencies = {},
): ReturnType<typeof suggestOrAnswer> {
  return traceModelCall('schema-chat', async () => {
    const { suggestion, answer } = await schemaChatRoutes(caller, input.temperature, dependencies)
    if (suggestion.profile === 'general') return suggestOrAnswer(suggestion, input, question, dependencies)
    const answered = answer && await answerIfQuestion(answer, input.document.markdown
      ? { markdown: input.document.markdown, pageSpans: input.document.pageSpans }
      : null, question, input)
    return answered ? { answer: answered } : suggestOrAnswer(suggestion, input, null, dependencies)
  }, (result) => ('answer' in result ? result : result.template))
}
