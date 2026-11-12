import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SchemaNode } from 'extraction/schema'
import { deleteModelOperation, requestSchemaChat, requestSchemaEdit } from './api'
import type { ChatHistory } from '../shared/schemaChat.contract'
import type { SchemaEditorController } from './currentSchemaRevision'
import { deriveSchemaProposal } from '../shared/schemaChanges'
import { useSchemaInstructions, type SchemaInstructions } from './useSchemaInstructions'
import { useSchemaProposalReview, type SchemaProposalReview } from './useSchemaProposalReview'
import { useModelOperationRecovery } from './useModelOperationRecovery'
import { schemaAncestorIds } from './schemaEditorTree'
import { boundedHistory, useProjectChatLog } from './projectChat'
import { PROJECT_CHAT_TEXT_LIMIT, type ProjectChatEntry } from '../shared/projectChat.contract'

const EMPTY_NODES: SchemaNode[] = []
/** The reply when the researcher turns down what was offered and asks for nothing else (no action). */
export const NO_ACTION_REPLY = 'If you need help, please use the chat box below.'

/** A conversation entry: a message, a guided step the researcher answered (its title and the choice made), or the
 *  Source Document the researcher turned to before what follows was said. */
export type ChatMsg =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'step'; title: string; choice: string }
  | { role: 'document'; sourceDocumentId: string; name: string }
  /** Where an instruction (or an answered question) kept for generation was said: shown from the instructions by its id. */
  | { role: 'instruction'; id: string }

/** Where a chat is kept: its Project Context, and the Source Document open now. */
export type ChatScope = { projectContextId: string; sourceDocumentId: string; name: string }

const clamp = (text: string) => text.slice(0, PROJECT_CHAT_TEXT_LIMIT)
function chatEntry(message: ChatMsg): ProjectChatEntry {
  switch (message.role) {
    case 'step': return { kind: 'step', title: message.title.slice(0, 500), choice: message.choice.slice(0, 500) }
    case 'document': return { kind: 'document', sourceDocumentId: message.sourceDocumentId, name: message.name.slice(0, 500) }
    case 'instruction': throw new Error('An instruction is kept by its own entry.')
    default: return { kind: 'message', role: message.role, text: clamp(message.text) }
  }
}
/** What the model reads of the conversation: messages, and a note for each document turned to; steps are clicks. */
const historyOf = (messages: readonly ChatMsg[]): ChatHistory => messages.flatMap((message): ChatHistory =>
  message.role === 'step' || message.role === 'instruction' ? []
    : message.role === 'document' ? [{ role: 'note', text: `The researcher turned to the Source Document “${message.name}”.` }]
      : [message])

export type SchemaChat = {
  readonly instructions: SchemaInstructions
  readonly messages: readonly ChatMsg[]
  readonly input: string
  setInput(value: string): void
  /** An edit request is running. */
  readonly loading: boolean
  /** The pre-generation message whose reply is coming, and why the last one got none. */
  readonly asking: string | null
  readonly askError: string | null
  readonly proposalReview: SchemaProposalReview
  readonly recovery: ReturnType<typeof useModelOperationRecovery>
  /** The researcher's open or collapse of the conversation; null keeps the host's default. */
  /** Some of the conversation could not be saved with the project yet. */
  readonly unsaved: boolean
  readonly drawerOpen: boolean | null
  setDrawerOpen(open: boolean | null): void
  /** Groups to expand so a proposal's changes show; `seq` changes with every request. */
  readonly revealed: { seq: number; ids: ReadonlySet<string> }
  /** Sends an edit request after the first schema: answered, or a proposal to review. */
  send(text: string): Promise<void>
  /** Sends the instructions draft, or `message` from a step, before the first schema: a question is answered, anything
   *  else kept. */
  ask(message?: string): Promise<void>
  /** Stops waiting for `ask`'s reply: the message goes back to the composer, unsent. */
  stopAsking(): void
  /** Stops a running edit request: the message is taken back from the conversation into the composer. */
  cancel(): void
  apply(): void
  discard(): void
  appendMessage(message: string): void
  appendStep(title: string, choice: string): void
  /** A message asked for the extraction to run: its request, until the researcher chooses what to extract. */
  readonly extractRequest: number | null
  clearExtractRequest(): void
  /** Stops a running request and drops the proposal; with `clearConversation` also the conversation and instructions. */
  reset(clearConversation?: boolean): void
  /** Clears the conversation where it is kept, then here: every message, instruction, step and document turn. Rejects,
   *  changing nothing shown, when the stored chat could not be cleared. */
  clearConversation(): Promise<void>
}

/**
 * The schema chat's state, lifted out of the panel so a host can show the conversation beside any tab: the
 * instructions conversation before the first schema, the edit chat after it, its proposal review, and the recovery of
 * requests a reload left running.
 */
export function useSchemaChat({ schema, sourceRepresentationId, scope = null }: {
  schema: SchemaEditorController
  sourceRepresentationId?: string
  /** Kept with this Project Context, read back when the chat opens again; without it the chat lasts as long as the page. */
  scope?: ChatScope | null
}): SchemaChat {
  const log = useProjectChatLog(scope?.projectContextId ?? null)
  const { keep: keepEntries, remove: removeEntry, clear: clearLog } = log
  const keep = useCallback(
    (shown: readonly ChatMsg[]) => keepEntries(shown.map((message) => ({ id: crypto.randomUUID(), entry: chatEntry(message) }))),
    [keepEntries],
  )
  // An instruction (or answered question) is shown where it is said, in the conversation's order (a turn to this
  // document first), and kept in that order; the conversation is set up below.
  const said = useRef<(id: string) => void>(() => {})
  const instructions = useSchemaInstructions({
    onAdd: ({ id, text, answer }) => {
      said.current(id)
      keepEntries([{ id, entry: { kind: 'instruction', text: clamp(text), ...(answer === undefined ? {} : { answer: clamp(answer) }) } }])
    },
    onRemove: removeEntry,
  })
  const [messages, setMessages] = useState<ChatMsg[]>([])
  // The document what is said next is about: a turn to another one is shown, and kept, before it.
  const documentRef = useRef(scope && { sourceDocumentId: scope.sourceDocumentId, name: scope.name })
  useEffect(() => { documentRef.current = scope && { sourceDocumentId: scope.sourceDocumentId, name: scope.name } })
  const shownDocument = useRef<string | null>(null)
  const show = useCallback((said: readonly ChatMsg[]): ChatMsg[] => {
    const document = documentRef.current
    const turn: ChatMsg[] = document && shownDocument.current !== document.sourceDocumentId ? [{ role: 'document', ...document }] : []
    if (document) shownDocument.current = document.sourceDocumentId
    const shown = [...turn, ...said]
    setMessages((current) => [...current, ...shown])
    return shown
  }, [])
  useEffect(() => {
    said.current = (id) => keep(show([{ role: 'instruction', id }]).filter((message) => message.role !== 'instruction'))
  })
  // The stored conversation, once read, goes ahead of anything said meanwhile.
  const restoreInstructions = instructions.restore
  const restored = useRef(false)
  useEffect(() => {
    if (!log.loaded || restored.current) return
    restored.current = true
    const stored = log.loaded
    restoreInstructions(stored.flatMap(({ id, entry }) => entry.kind === 'instruction'
      ? [{ id, text: entry.text, ...(entry.answer === undefined ? {} : { answer: entry.answer }) }] : []))
    const earlier = stored.flatMap(({ id, entry }): ChatMsg[] => {
      switch (entry.kind) {
        case 'instruction': return [{ role: 'instruction', id }]
        case 'message': return [{ role: entry.role, text: entry.text }]
        case 'step': return [{ role: 'step', title: entry.title, choice: entry.choice }]
        case 'document': return [{ role: 'document', sourceDocumentId: entry.sourceDocumentId, name: entry.name }]
        default: return []
      }
    })
    const lastTurn = earlier.findLast((message) => message.role === 'document')
    if (shownDocument.current === null && lastTurn?.role === 'document') shownDocument.current = lastTurn.sourceDocumentId
    setMessages((current) => [...earlier, ...current])
  }, [log.loaded, restoreInstructions])
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null)
  const [revealed, setRevealed] = useState<{ seq: number; ids: ReadonlySet<string> }>(() => ({ seq: 0, ids: new Set() }))
  const reveal = useCallback((ids: ReadonlySet<string>) => setRevealed((current) => ({ seq: current.seq + 1, ids })), [])
  // Each request its own number, so a new one is a new step (its ticks start afresh).
  const [extractRequest, setExtractRequest] = useState<number | null>(null)
  const extractRequests = useRef(0)
  const appendMessage = useCallback(
    (message: string) => keep(show([{ role: 'assistant', text: message }])),
    [keep, show],
  )
  const appendStep = useCallback(
    (title: string, choice: string) => keep(show([{ role: 'step', title, choice }])),
    [keep, show],
  )
  const proposalReview = useSchemaProposalReview(schema, appendMessage)
  const { pending, reset: resetProposal } = proposalReview
  const resetInstructions = instructions.reset
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  /** The running edit's operation ID: Stop cancels it on the server (Task 6) and Discard names it (Task 7). */
  const editOperationRef = useRef<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  const askAbortRef = useRef<AbortController | null>(null)
  /** The running question's operation ID: Stop cancels it on the server, not only the wait for it. */
  const askOperationRef = useRef<string | null>(null)
  useEffect(() => () => {
    abortRef.current?.abort()
    abortRef.current = null
    askAbortRef.current?.abort()
    askAbortRef.current = null
  }, [])
  // What a reloaded page found (spec, *What the schema panel does on load*): running operations to show and poll, a
  // finished generation to save onto its base, an unreviewed proposal to reopen.
  const recovery = useModelOperationRecovery({
    schema,
    proposalReview,
    busy: loading || pending !== null,
    appendMessage,
    onReopened: (proposal) => {
      // A reopened proposal is reviewed in the conversation, as one that has just arrived.
      setDrawerOpen(true)
      reveal(schemaAncestorIds(proposal.reviewNodes, new Set(proposal.changes.map(({ id }) => id))))
    },
  })

  const reset = useCallback(
    (clearConversation = false) => {
      abortRef.current?.abort()
      abortRef.current = null
      setLoading(false)
      resetProposal()
      setExtractRequest(null)
      setInput('')
      if (clearConversation) {
        resetInstructions()
        setMessages([])
        setDrawerOpen(null)
      }
    },
    [resetInstructions, resetProposal],
  )
  const clearConversation = useCallback(async () => {
    await clearLog()
    askAbortRef.current?.abort()
    askAbortRef.current = null
    setAsking(null)
    setAskError(null)
    reset(true)
    // A stored chat still on its way is not brought back; what is said next names its document again.
    restored.current = true
    shownDocument.current = null
  }, [clearLog, reset])
  // A wholesale replacement of the draft ends any request and proposal made on the one it replaced.
  const replacementVersion = useSyncExternalStore(schema.subscribe, () => schema.snapshot().replacementVersion)
  const observedReplacementVersion = useRef(replacementVersion)
  useEffect(() => {
    if (observedReplacementVersion.current === replacementVersion) return
    observedReplacementVersion.current = replacementVersion
    reset()
  }, [reset, replacementVersion])

  async function send(text: string) {
    if (!text.trim() || loading || pending) return
    setDrawerOpen(true)
    const userMsg = text.trim()
    const sent: ChatMsg = { role: 'user', text: userMsg }
    const shown = show([sent])
    // The conversation before the message as the model reads it, a turn to this document last.
    const history = boundedHistory([...instructions.history, ...historyOf([...messages, ...shown.slice(0, -1)])])
    // Kept once it is answered (or fails), ahead of its answer; a message taken back with Stop is never kept.
    let kept = false
    const keepSent = () => { if (!kept) { kept = true; keep(shown) } }
    const say = (message: string) => { keepSent(); appendMessage(message) }
    setInput('')
    setLoading(true)
    const controller = new AbortController()
    abortRef.current = controller
    // A new user action, a new ID (spec, *Client IDs*): Studio replays the same one if the POST is repeated.
    const operationId = crypto.randomUUID()
    editOperationRef.current = operationId

    const versionBeforeFlush = schema.snapshot().draftVersion
    try {
      const modelContext = await schema.requestModelEdit()
      if (schema.snapshot().draftVersion !== versionBeforeFlush) {
        say('Template changed while the request was running. Send the request again.')
        return
      }
      const original = schema.snapshot().draft?.schemaNodes ?? EMPTY_NODES
      const originalDraftVersion = schema.snapshot().draftVersion
      const originalSchemaRevisionId = modelContext.schemaRevisionId
      // The conversation goes with the message (the instructions before the first schema, then this chat), its latest
      // part where it is long.
      const response = await requestSchemaEdit(
        modelContext,
        userMsg,
        controller.signal,
        operationId,
        history,
      )
      const currentAfterResponse = schema.snapshot()
      if (
        currentAfterResponse.draftVersion !== originalDraftVersion ||
        currentAfterResponse.extractableSchemaRevisionId !==
          originalSchemaRevisionId
      ) {
        say('Template changed while the request was running. Send the request again.')
        return
      }
      if (response.status === 'answered') {
        say(response.answer)
      } else if (response.status === 'declined') {
        say(NO_ACTION_REPLY)
      } else if (response.status === 'requested') {
        // Studio, not the model, offers what may run: the step below asks which documents.
        say('Choose what to extract below.')
        setExtractRequest(extractRequests.current += 1)
      } else if (response.status === 'refused' || response.status === 'failed') {
        say(`${response.status === 'refused' ? 'Request refused' : 'Request failed'}: ${response.message}`)
      } else {
        const proposal = deriveSchemaProposal(original, response)
        if (proposal.changes.length === 0 && proposal.issues.length === 0) {
          say('That leaves the template as it is: every field already fits it. To extract values, say so, or choose the step below.')
        } else {
          keepSent()
          proposalReview.start(
            proposal,
            original,
            originalDraftVersion,
            originalSchemaRevisionId,
            `edit:${operationId}`,
          )
          // A pending proposal keeps the drawer open with its Apply / Discard bar, even if it was collapsed meanwhile.
          setDrawerOpen(true)
          reveal(schemaAncestorIds(proposal.reviewNodes, new Set(proposal.changes.map(({ id }) => id))))
        }
      }
    } catch (err) {
      if (abortRef.current !== controller) return
      if (
        typeof err === 'object' &&
        err !== null &&
        'name' in err &&
        err.name === 'AbortError'
      ) {
        // Stopped by the researcher: the message is taken back to edit and send again. A turn to this document stays.
        setMessages((current) => current.filter((message) => message !== sent))
        keep(shown.filter((message) => message !== sent))
        setInput(userMsg)
      } else {
        // The sent message stays in the conversation above the error; the composer stays empty for the next one.
        say(`Error: ${err instanceof Error ? err.message : 'Request failed'}`)
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        editOperationRef.current = null
        setLoading(false)
      }
    }
  }

  function cancel() {
    // A user's Stop: cancel the proposal on the server, then stop waiting. The unmount cleanup only aborts.
    const operationId = editOperationRef.current
    if (operationId)
      void deleteModelOperation(`edit:${operationId}`).catch(() =>
        appendMessage('The request could not be stopped on the server; it may still be running and will show as an earlier request after a reload.'),
      )
    abortRef.current?.abort()
  }

  function stopAsking() {
    // The reply is not waited for, so nothing is recorded: the message returns ahead of anything typed since.
    if (asking === null) return
    const operationId = askOperationRef.current
    askOperationRef.current = null
    // Already answered, or gone: there is nothing left to stop.
    if (operationId) void deleteModelOperation(`chat:${operationId}`).catch(() => {})
    askAbortRef.current?.abort()
    askAbortRef.current = null
    setAsking(null)
    const typed = instructions.draft.trim()
    instructions.setDraft(typed ? `${asking}\n${typed}` : asking)
  }

  // A message before the first schema asks the model whether it is a question: a question is answered from the document,
  // a message that only declines is answered with NO_ACTION_REPLY, anything else is kept as an instruction for generation. Without a source to read it is kept as one directly.
  async function ask(message?: string) {
    const fromDraft = message === undefined
    const text = (message ?? instructions.draft).trim()
    const projectContextId = schema.operationScope()?.projectContextId
    if (!text || asking !== null) return
    if (fromDraft) instructions.setDraft('')
    if (!projectContextId || !sourceRepresentationId) {
      instructions.add(text)
      return
    }
    const controller = new AbortController()
    askAbortRef.current = controller
    setAskError(null)
    setAsking(text)
    const operationId = crypto.randomUUID()
    askOperationRef.current = operationId
    try {
      const reply = await requestSchemaChat(
        { projectContextId, sourceRepresentationRevisionId: sourceRepresentationId },
        text,
        controller.signal,
        operationId,
        boundedHistory(instructions.history),
      )
      if (askAbortRef.current !== controller) return
      // Only a no: shown with the reply, never kept for generation.
      if (reply.kind === 'none') keep(show([{ role: 'user', text }, { role: 'assistant', text: NO_ACTION_REPLY }]))
      else instructions.add(text, reply.kind === 'answer' ? reply.answer : undefined)
    } catch (err) {
      if (askAbortRef.current !== controller) return
      // Nothing was recorded: the message goes back to the composer to send again.
      instructions.setDraft(text)
      setAskError(`Could not send the message: ${err instanceof Error ? err.message : 'Request failed'}`)
    } finally {
      if (askAbortRef.current === controller) {
        askAbortRef.current = null
        askOperationRef.current = null
        setAsking(null)
      }
    }
  }

  return {
    instructions,
    messages,
    input,
    setInput,
    loading,
    asking,
    askError,
    proposalReview,
    recovery,
    unsaved: log.unsaved,
    clearConversation,
    drawerOpen,
    setDrawerOpen,
    revealed,
    send,
    ask,
    stopAsking,
    cancel,
    // A refused or stale Apply keeps the drawer open: its explanation, and a refused proposal's review, stay in view.
    apply: () => { if (proposalReview.apply()) setDrawerOpen(false) },
    discard: () => { proposalReview.discard(); setDrawerOpen(false) },
    appendMessage,
    appendStep,
    extractRequest,
    clearExtractRequest: () => setExtractRequest(null),
    reset,
  }
}
