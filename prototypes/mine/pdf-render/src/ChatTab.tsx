import { useState } from 'react'

type ChatMessage = {
  id: number
  role: 'user' | 'free'
  text: string
}

let nextMessageId = 1

function ChatTab() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')

  function send() {
    const text = draft.trim()
    if (!text) {
      return
    }
    setMessages((current) => [
      ...current,
      { id: nextMessageId++, role: 'user', text },
      {
        id: nextMessageId++,
        role: 'free',
        text: 'Chat is not connected to the backend yet — grounded answers with jump-to-source citations are coming soon.',
      },
    ])
    setDraft('')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scrollbar-subtle flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3.5">
        {messages.length === 0 && (
          <div className="mt-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
            <p aria-hidden="true" className="font-serif text-[22px] leading-none text-ink-muted">
              ❝
            </p>
            <p className="mt-1.5 text-[13.5px] font-semibold text-ink">Ask about this document</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Answers are grounded in the open report — every citation jumps to its source passage.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`animate-fadeup max-w-[90%] rounded-xl border px-3 py-2 text-xs leading-relaxed text-ink ${
              message.role === 'user'
                ? 'self-end border-accent-soft bg-accent-ghost'
                : 'self-start border-line bg-canvas'
            }`}
          >
            {message.text}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line px-3 py-2.5">
        <input
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 py-2 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent"
          value={draft}
          placeholder="Ask about this document…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              send()
            }
          }}
        />
        <button
          className="shrink-0 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 py-2 text-[13px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40"
          type="button"
          title="Send"
          onClick={send}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

export default ChatTab
