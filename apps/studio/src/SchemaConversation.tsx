import { useEffect, useRef } from 'react'
import ChatDrawer from './ChatDrawer'
import { ChatLabel, ChatTranscript } from './SchemaChatParts'
import { ProposalReviewBar } from './SchemaProposalReview'
import type { SchemaChat } from './useSchemaChat'

export default function SchemaConversation({ chat }: { chat: SchemaChat }) {
  const chatRef = useRef<HTMLDivElement>(null)
  const { pending, canApply } = chat.proposalReview
  const drawerShown = chat.drawerOpen ?? chat.recovery.running.length > 0
  useEffect(() => {
    const element = chatRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [chat.messages.length, pending, drawerShown])
  const chatLoading = chat.loading
  const chatBlocked = !!pending || chatLoading
  const dot = drawerShown ? null : chat.recovery.running.length ? { title: 'An earlier request is still running' } : chat.messages.length || pending ? { title: 'Show conversation' } : null
  const applyProposal = chat.apply
  const discardProposal = chat.discard
  const CONVERSATION_EMPTY = "Describe a change to review it before applying."
  return (
        <ChatDrawer open={drawerShown} onCollapse={() => chat.setDrawerOpen(false)} onExpand={() => chat.setDrawerOpen(true)}
          title="Conversation" label={<ChatLabel />} dot={dot} bodyRef={chatRef}
          bar={pending ? <ProposalReviewBar proposal={pending} canApply={canApply} onApply={applyProposal} onDiscard={discardProposal} /> : undefined}
          composer={
            <>
              <textarea className="min-w-0 flex-1 resize-none bg-transparent font-sans text-secondary leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-50" rows={3}
                placeholder="Describe a change to the template…" value={chat.input} disabled={chatBlocked}
                onChange={(event) => chat.setInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void chat.send(chat.input) } }} />
              {chatLoading ? (
                <button type="button" className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-danger text-compact text-white outline-none hover:brightness-108"
                  onClick={chat.cancel} title="Stop and edit the message" aria-label="Stop template edit request">■</button>
              ) : (
                <button type="button" className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40"
                  aria-label="Send" disabled={!chat.input.trim() || chatBlocked} onClick={() => void chat.send(chat.input)}>↑</button>
              )}
            </>
          }>
          <ChatTranscript chat={chat} empty={CONVERSATION_EMPTY} />
        </ChatDrawer>
  )
}
