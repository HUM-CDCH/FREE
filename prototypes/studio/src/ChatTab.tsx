import { DefaultChatTransport, readUIMessageStream } from 'ai'
import type { UIMessage } from 'ai'
import { useRef, useState } from 'react'
import { API_BASE } from './api'

type ChatTabProps = {
  documentMarkdown: string | null
}

const transport = new DefaultChatTransport<UIMessage>({
  api: `${API_BASE}/chat`,
  prepareSendMessagesRequest: ({ messages, body }) => ({
    body: { messages, documentMarkdown: body?.documentMarkdown },
  }),
})

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function nextId(): string {
  return crypto.randomUUID()
}


function ChatTab({ documentMarkdown }: ChatTabProps) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'ready' | 'running' | 'error'>('ready')
  const abortRef = useRef<AbortController | null>(null)

  async function send() {
    const text = draft.trim()
    if (!text || status === 'running' || documentMarkdown === null) {
      return
    }

    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    setStatus('running')
    setDraft('')

    const nextMessages: UIMessage[] = [
      ...messages,
      {
        id: nextId(),
        role: 'user',
        parts: [{ type: 'text', text }],
      },
    ]
    setMessages(nextMessages)

    try {
      const stream = await transport.sendMessages({
        chatId: 'free-document-chat',
        messages: nextMessages,
        trigger: 'submit-message',
        messageId: undefined,
        abortSignal: abortController.signal,
        body: { documentMarkdown },
      })

      for await (const assistantMessage of readUIMessageStream({ stream, terminateOnError: true })) {
        setMessages([...nextMessages, assistantMessage])
      }
      setStatus('ready')
    } catch (error) {
      if (abortController.signal.aborted) {
        return
      }
      const message = error instanceof Error ? error.message : 'Chat failed.'
      setMessages([
        ...nextMessages,
        {
          id: nextId(),
          role: 'assistant',
          parts: [{ type: 'text', text: message }],
        },
      ])
      setStatus('error')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scrollbar-subtle flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3.5">
        {messages.length === 0 && (
          <div className="mt-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
            <p className="text-[13.5px] font-semibold text-ink">Ask about this source document</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              {documentMarkdown !== null
                ? 'Canonical Source Document Markdown is included with each question.'
                : 'No Source Document Markdown is available yet.'}
            </p>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`animate-fadeup max-w-[90%] rounded-xl border px-3 py-2 text-[13px] leading-relaxed text-ink ${
              message.role === 'user'
                ? 'self-end border-accent-soft bg-accent-ghost'
                : 'self-start border-line bg-canvas'
            }`}
          >
            {messageText(message)}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line px-3 py-2.5">
        <input
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent"
          value={draft}
          placeholder="Ask about this source document..."
          disabled={status === 'running' || documentMarkdown === null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void send()
            }
          }}
        />
        <button
          className="shrink-0 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 py-2 text-[13px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-60"
          type="button"
          title="Send"
          disabled={status === 'running' || documentMarkdown === null}
          onClick={() => void send()}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

export default ChatTab
