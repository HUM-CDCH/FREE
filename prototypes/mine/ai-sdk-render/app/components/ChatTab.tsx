import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type FileUIPart } from 'ai'
import { useMemo, useRef, useState } from 'react'
import { rasterizePdfToJpegPages } from './rasterize'
import type { AiProviderSettings } from '../lib/provider-settings'

type ChatTabProps = {
  providerSettings: AiProviderSettings
  pdfSource: { url: string; filename: string } | null
}

function messageText(message: { parts?: Array<{ type: string; text?: string }> }) {
  return (
    message.parts
      ?.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('') ?? ''
  )
}

function ChatTab({ providerSettings, pdfSource }: ChatTabProps) {
  const [draft, setDraft] = useState('')
  const [attachingSource, setAttachingSource] = useState(false)
  const providerSettingsRef = useRef(providerSettings)
  providerSettingsRef.current = providerSettings
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: () => ({ providerSettings: providerSettingsRef.current }),
      }),
    [],
  )
  const { messages, sendMessage, error, status } = useChat({ transport })

  async function sourceFileParts(): Promise<FileUIPart[]> {
    if (!pdfSource) {
      return []
    }
    setAttachingSource(true)
    try {
      // Attach the document as page images, not raw PDF — NuExtract3 is vision-only
      // and the provider SDKs drop PDF parts. See app/components/rasterize.ts.
      const blob = await (await fetch(pdfSource.url)).blob()
      const pages = await rasterizePdfToJpegPages(blob)
      return pages.map((dataUrl, index) => ({
        type: 'file',
        filename: `page-${index + 1}.jpg`,
        mediaType: 'image/jpeg',
        url: dataUrl,
      }))
    } finally {
      setAttachingSource(false)
    }
  }

  async function send() {
    const text = draft.trim()
    if (!text || status !== 'ready') {
      return
    }
    const files = await sourceFileParts()
    sendMessage({ text, files })
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
              Answers stream through the selected AI SDK provider with the source document attached.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`animate-fadeup max-w-[90%] whitespace-pre-wrap rounded-xl border px-3 py-2 text-xs leading-relaxed text-ink ${
              message.role === 'user'
                ? 'self-end border-accent-soft bg-accent-ghost'
                : 'self-start border-line bg-canvas'
            }`}
          >
            {messageText(message)}
          </div>
        ))}
        {error && (
          <div className="animate-fadeup max-w-[90%] self-start rounded-xl border border-danger/40 bg-surface px-3 py-2 text-xs leading-relaxed text-danger">
            {error.message}
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line px-3 py-2.5">
        <input
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-3 py-2 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent"
          value={draft}
          placeholder="Ask about this document..."
          disabled={status !== 'ready' || attachingSource}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void send()
            }
          }}
        />
        <button
          className="shrink-0 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 py-2 text-[13px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:border-line disabled:bg-line disabled:text-ink-muted"
          type="button"
          title="Send"
          disabled={status !== 'ready' || attachingSource}
          onClick={() => void send()}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

export default ChatTab
