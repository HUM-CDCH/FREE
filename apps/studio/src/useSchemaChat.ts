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

const EMPTY_NODES: SchemaNode[] = []

/** A conversation entry: a message, or a guided step the researcher answered (its title and the choice made). */
export type ChatMsg =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'step'; title: string; choice: string }

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
  readonly drawerOpen: boolean | null
  setDrawerOpen(open: boolean | null): void
  /** Groups to expand so a proposal's changes show; `seq` changes with every request. */
  readonly revealed: { seq: number; ids: ReadonlySet<string> }
  /** Sends an edit request after the first schema: answered, or a proposal to review. */
  send(text: string): Promise<void>
  /** Sends the instructions draft before the first schema: a question is answered, anything else kept. */
  ask(): Promise<void>
  cancel(): void
  apply(): void
  discard(): void
  appendMessage(message: string): void
  appendStep(title: string, choice: string): void
  /** Stops a running request and drops the proposal; with `clearConversation` also the conversation and instructions. */
  reset(clearConversation?: boolean): void
}

/**
 * The schema chat's state, lifted out of the panel so a host can show the conversation beside any tab: the
 * instructions conversation before the first schema, the edit chat after it, its proposal review, and the recovery of
 * requests a reload left running.
 */
export function useSchemaChat({ schema, sourceRepresentationId }: {
  schema: SchemaEditorController
  sourceRepresentationId?: string
}): SchemaChat {
  const instructions = useSchemaInstructions()
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null)
  const [revealed, setRevealed] = useState<{ seq: number; ids: ReadonlySet<string> }>(() => ({ seq: 0, ids: new Set() }))
  const reveal = useCallback((ids: ReadonlySet<string>) => setRevealed((current) => ({ seq: current.seq + 1, ids })), [])
  const appendMessage = useCallback(
    (message: string) => setMessages((current) => [...current, { role: 'assistant', text: message }]),
    [],
  )
  const appendStep = useCallback(
    (title: string, choice: string) => setMessages((current) => [...current, { role: 'step', title, choice }]),
    [],
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
      setInput('')
      if (clearConversation) {
        resetInstructions()
        setMessages([])
        setDrawerOpen(null)
      }
    },
    [resetInstructions, resetProposal],
  )
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
    setMessages(c => [...c, { role: 'user', text: userMsg }])
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
        appendMessage('Schema changed while the request was running. Send the request again.')
        return
      }
      const original = schema.snapshot().draft?.schemaNodes ?? EMPTY_NODES
      const originalDraftVersion = schema.snapshot().draftVersion
      if (!modelContext) {
        appendMessage('Save this Extraction Schema before requesting a model edit.')
        return
      }
      const originalSchemaRevisionId = modelContext.schemaRevisionId
      // The whole conversation goes with the message: the instructions before the first schema, then this chat. An
      // answered step is the researcher's click, not something said, so it stays out.
      const history = messages.flatMap((message): ChatHistory => message.role === 'step' ? [] : [message])
      const response = await requestSchemaEdit(
        modelContext,
        userMsg,
        controller.signal,
        operationId,
        [...instructions.history, ...history],
      )
      const currentAfterResponse = schema.snapshot()
      if (
        currentAfterResponse.draftVersion !== originalDraftVersion ||
        currentAfterResponse.extractableSchemaRevisionId !==
          originalSchemaRevisionId
      ) {
        appendMessage('Schema changed while the request was running. Send the request again.')
        return
      }
      if (response.status === 'answered') {
        appendMessage(response.answer)
      } else if (response.status === 'refused' || response.status === 'failed') {
        appendMessage(`${response.status === 'refused' ? 'Request refused' : 'Request failed'}: ${response.message}`)
      } else {
        const proposal = deriveSchemaProposal(original, response)
        if (proposal.changes.length === 0 && proposal.issues.length === 0) {
          appendMessage('Proposal checked every field: 0 changes proposed.')
        } else {
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
        appendMessage('Cancelled.')
      } else {
        // The sent message stays in the conversation above the error; the composer stays empty for the next one.
        appendMessage(`Error: ${err instanceof Error ? err.message : 'Request failed'}`)
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

  // A message before the first schema asks the model whether it is a question: a question is answered from the document,
  // anything else is kept as an instruction for generation. Without a source to read it is kept as one directly.
  async function ask() {
    const text = instructions.draft.trim()
    const projectContextId = schema.operationScope()?.projectContextId
    if (!text || asking !== null) return
    if (!projectContextId || !sourceRepresentationId) {
      instructions.send()
      return
    }
    const controller = new AbortController()
    askAbortRef.current = controller
    instructions.setDraft('')
    setAskError(null)
    setAsking(text)
    try {
      const reply = await requestSchemaChat(
        { projectContextId, sourceRepresentationRevisionId: sourceRepresentationId },
        text,
        controller.signal,
        crypto.randomUUID(),
        instructions.history,
      )
      if (askAbortRef.current !== controller) return
      instructions.add(text, reply.kind === 'answer' ? reply.answer : undefined)
    } catch (err) {
      if (askAbortRef.current !== controller) return
      // Nothing was recorded: the message goes back to the composer to send again.
      instructions.setDraft(text)
      setAskError(`Could not send the message: ${err instanceof Error ? err.message : 'Request failed'}`)
    } finally {
      if (askAbortRef.current === controller) {
        askAbortRef.current = null
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
    drawerOpen,
    setDrawerOpen,
    revealed,
    send,
    ask,
    cancel,
    // A refused or stale Apply keeps the drawer open: its explanation, and a refused proposal's review, stay in view.
    apply: () => { if (proposalReview.apply()) setDrawerOpen(false) },
    discard: () => { proposalReview.discard(); setDrawerOpen(false) },
    appendMessage,
    appendStep,
    reset,
  }
}
