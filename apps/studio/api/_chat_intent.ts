import { executeSchemaSuggestion } from './_model_execution.js'
import type { GeneralExecutionTarget } from './_provider.js'
import { parseJsonObject } from './_model_output.js'
import { chatHistoryText } from './_schema.js'
import type { ChatHistory, ChatWhere } from '../shared/schemaChat.contract.js'

/**
 * What a chat message asks for (ADR 0034), the same in every state of the workspace: Studio decides what each does
 * where it is. `edit` changes the template, or says what it should hold; `correct` changes particular extracted values
 * (ADR 0035).
 */
export const CHAT_INTENTS = ['question', 'generate', 'edit', 'correct', 'extract', 'confirm', 'none'] as const
export type ChatIntent = (typeof CHAT_INTENTS)[number]
/** A message's intent, and for `generate` what the template should hold, in the researcher's words. */
export type ClassifiedMessage = Readonly<{ intent: ChatIntent; focus: string | null }>

/** The message to classify: its text, the chat before it, what the chat offers beside it (its step's title and
 *  question), which a `confirm` or `none` answers, and where the researcher is (ADR 0040). */
export type ChatMessageToClassify = Readonly<{ message: string; history: ChatHistory; offer?: string | null; where?: ChatWhere | null }>

const VIEW_WORDS: Record<ChatWhere['view'], string> = {
  chat: 'the chat',
  template: 'the template',
  results: 'the extracted results',
}
/** Where the researcher is, said to the classifier, and how it settles a message that could be "edit" or "correct". */
function whereText(where: ChatWhere): string {
  const leaning = where.results && where.view === 'results' ? '"correct"' : !where.results || where.view === 'template' ? '"edit"' : null
  return `\nThe researcher is looking at ${VIEW_WORDS[where.view]}. ${where.results
    ? 'Extracted results are shown whose values the message can change.'
    : 'No extracted results are shown, so there are no values the message can change.'}${leaning
    ? ` A message that could be read either as "edit" or as "correct" is ${leaning}.` : ''}\n`
}

const INSTRUCTIONS = 'Classify the researcher\'s chat message. Return only one JSON object, with no Markdown fences or commentary.'
/** Read when nothing else is: a message is a change to the template, or before it an instruction, as it always was. */
const FALLBACK: ClassifiedMessage = { intent: 'edit', focus: null }

/** The classification request: one fixed list of intents, whatever the state; no document, no schema. */
export function chatIntentPrompt({ message, history, offer, where }: ChatMessageToClassify): string {
  const conversation = chatHistoryText(history)
  return `The researcher is in a chat about extracting data from a source document with an extraction schema, which Studio shows them as the "template".
${conversation ? `\n${conversation}\n` : ''}${offer?.trim() ? `\nStudio has just offered: ${offer.trim()}\n` : ''}${where ? whereText(where) : ''}
The researcher's latest chat message:
${message.trim()}

Return only {"intent":"<intent>","focus":<text or null>}, with the one intent the message has:
- "question": asks something about the source document, the template or the results, to be answered.
- "generate": asks for a template to be made from the document, or made again ("give me a template of this doc", "suggest a template", "start the template over", "生成模板").
- "edit": asks to change the template, or says what it should hold or leave out ("add a date field", "focus on names and places", "把 length 改成整数").
- "correct": says that particular extracted values in the results are wrong, or asks to change, fill in or remove them ("the year of record 3 should be 1854", "grave 8 is 1.80 m long, not 1.72", "删掉第二条的作者", "this title is wrong").
- "extract": asks to run the extraction with the template as it is, to get the values or results, from this document or others ("run it", "extract all the documents", "提取数据", "跑一下").
- "confirm": agrees to what Studio has just offered and asks for nothing else ("yes", "ok", "go ahead", "好的", "继续").
- "none": declines what was offered and asks for nothing else ("no", "not now", "no thanks", "不用了", "算了").
A message that says how a field should be read from now on, or for every value, is "edit"; one that fixes particular values is "correct". A message that asks for a change and also to run the extraction is "edit". For "generate", "focus" is what the template should hold if the message says so, in its words; otherwise "focus" is null.`
}

/** The classification of a reply `{"intent": …, "focus": …}` (the intent in any case); null for any other reply. */
export async function chatIntentOf(response: string): Promise<ClassifiedMessage | null> {
  const parsed = await parseJsonObject(response, 'Model returned invalid JSON.').catch(() => null)
  if (!parsed) return null
  const { intent, focus } = parsed
  const key = typeof intent === 'string' ? intent.trim().toLowerCase() : null
  const known = CHAT_INTENTS.find((candidate) => candidate === key)
  if (!known) return null
  return { intent: known, focus: known === 'generate' && typeof focus === 'string' && focus.trim() ? focus.trim() : null }
}

/** What a chat message asks for, read by the chat's general route before anything is answered or changed; a reply that
 *  names no intent is an `edit`. */
export async function classifyChatMessage(
  target: GeneralExecutionTarget,
  message: ChatMessageToClassify,
  call: Readonly<{ temperature?: number; signal?: AbortSignal }> = {},
): Promise<ClassifiedMessage> {
  const { response } = await executeSchemaSuggestion(target, {
    instructions: INSTRUCTIONS,
    guidance: chatIntentPrompt(message),
    // The intent is the message's own: the document is not read to classify it.
    documentParts: [{ type: 'text', text: '(Not needed to classify the message.)' }],
    temperature: call.temperature,
    signal: call.signal,
  })
  return (await chatIntentOf(response)) ?? FALLBACK
}
