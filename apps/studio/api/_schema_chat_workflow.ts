import { DBOS } from '@dbos-inc/dbos-sdk'
import type { SchemaSource } from 'db'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { persistenceUnavailable } from './_http.js'
import type { ModelCaller } from './_model_execution.js'
import { operationFailureOf, type OperationResult } from './_model_operation.js'
import { EXCERPT_THRESHOLD, schemaSourceWindows } from './_schema.js'
import type { answerFromWindow, answerSchemaChat, combineWindowAnswers, SchemaChatQuestion } from './_schema_chat.js'
import { modelStep, StepFailure } from './_schema_generation_workflow.js'
import type { SchemaChatReply } from '../shared/schemaChat.contract.js'

export const ANSWER_SCHEMA_CHAT = 'answerSchemaChat'
/** DBOS patch: a run past it lets an edit chat message ask a question, answered across a long source's windows. */
export const SCHEMA_CHAT_ANSWERS = 'schema-chat-answers'

/** IDs, the message and the temperature only: never the document, never a key (spec, *What DBOS history holds*). */
export type SchemaChatInput = Readonly<{
  operationId: string
  owner: string
  projectContextId: string
  sourceRepresentationRevisionId: string
  message: string
  temperature: number | null
}>
export type SchemaChatAnswered = { reply: SchemaChatReply }

/** How a question is answered across a long source's windows; the model calls of `_schema_chat`. */
export type WindowAnswerPorts = Readonly<{
  steps: WorkflowSteps
  answerWindow: typeof answerFromWindow
  combineAnswers: typeof combineWindowAnswers
}>
export type SchemaChatPorts = WindowAnswerPorts & Readonly<{
  readSource(sourceRepresentationRevisionId: string): Promise<SchemaSource | null>
  answer: typeof answerSchemaChat
}>

/** Whether a question answered from excerpts is answered again from every window: the source was excerpted. */
export const answeredFromExcerpts = (source: SchemaSource | null) => source !== null && source.markdown.length > EXCERPT_THRESHOLD

/**
 * A question over a long source: each window answered in its own step (`answerWindow:<n>`), then the answers combined
 * in one (`combineAnswers`). A failed step throws its `StepFailure`.
 */
export async function answerFromWindows(
  ports: WindowAnswerPorts,
  caller: ModelCaller,
  markdown: string,
  question: SchemaChatQuestion,
  temperature: number | null,
): Promise<string> {
  const call = temperature === null ? {} : { temperature }
  const windows = schemaSourceWindows(markdown)
  const answers: string[] = []
  for (const [index, text] of windows.entries()) {
    answers.push(await modelStep(ports.steps, `answerWindow:${index + 1}`, (signal) =>
      ports.answerWindow(caller, { text, index: index + 1, count: windows.length }, question, { ...call, signal })))
  }
  return modelStep(ports.steps, 'combineAnswers', (signal) => ports.combineAnswers(caller, answers, question, { ...call, signal }))
}

/**
 * `answerSchemaChat(input)`: a chat message before the first schema. One step asks whether it is a question and answers
 * it (`answerIfQuestion`); a long source's question is answered again across its windows. An instruction is the
 * page's to keep for generation: nothing is saved here.
 */
export async function answerSchemaChatWorkflow(
  input: SchemaChatInput,
  ports: SchemaChatPorts,
): Promise<OperationResult<SchemaChatAnswered>> {
  let source: SchemaSource | null
  try {
    source = await ports.readSource(input.sourceRepresentationRevisionId)
  } catch (cause) {
    return { ok: false, ...operationFailureOf(persistenceUnavailable(cause, 'Project model context storage is unavailable.')) }
  }
  if (source === null) return { ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' }
  const caller = { researcherAccountId: input.owner }
  const question = { message: input.message, context: null }
  try {
    const answer = await modelStep(ports.steps, 'answerIfQuestion', (signal) =>
      ports.answer(caller, source, input.message, { ...(input.temperature === null ? {} : { temperature: input.temperature }), signal }))
    if (answer === null) return { ok: true, reply: { kind: 'instruction' } }
    return {
      ok: true,
      reply: {
        kind: 'answer',
        answer: answeredFromExcerpts(source) ? await answerFromWindows(ports, caller, source.markdown, question, input.temperature) : answer,
      },
    }
  } catch (error) {
    if (error instanceof StepFailure) return { ok: false, ...error.failure }
    throw error
  }
}

export function registerSchemaChatWorkflow(ports: () => SchemaChatPorts): void {
  DBOS.registerWorkflow(async (input: SchemaChatInput) => answerSchemaChatWorkflow(input, ports()), { name: ANSWER_SCHEMA_CHAT })
}
