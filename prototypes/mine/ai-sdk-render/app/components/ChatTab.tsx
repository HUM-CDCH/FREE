import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type FileUIPart } from 'ai'
import { useEffect, useMemo, useRef, useState } from 'react'
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
  const [localError, setLocalError] = useState<string | null>(null)
  const providerSettingsRef = useRef(providerSettings)
  const sourcePartsPromiseRef = useRef<Promise<FileUIPart[]> | null>(null)
  const sourceAbortRef = useRef<AbortController | null>(null)
  providerSettingsRef.current = providerSettings
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages }) => {
          // Keep the single source-bearing message plus a bounded recent chat
          // window. Re-attaching the document to every user turn causes the
          // request body to grow by another full PDF on each submission.
          const sourceMessage = messages.find((message) =>
            message.parts.some((part) => part.type === 'file'),
          )
          const recentMessages = messages
            .filter((message) => message.id !== sourceMessage?.id)
            .slice(-12)

          return {
            body: {
              providerSettings: providerSettingsRef.current,
              messages: sourceMessage ? [sourceMessage, ...recentMessages] : recentMessages,
            },
          }
        },
      }),
    [],
  )
  const { messages, sendMessage, error, status } = useChat({ transport })

  useEffect(
    () => () => {
      sourceAbortRef.current?.abort()
    },
    [],
  )

  async function sourceFileParts(): Promise<FileUIPart[]> {
    if (!pdfSource) {
      return []
    }

    if (!sourcePartsPromiseRef.current) {
      const abortController = new AbortController()
      sourceAbortRef.current = abortController
      setAttachingSource(true)
      sourcePartsPromiseRef.current = (async () => {
        // Attach the document as page images, not raw PDF. NuExtract3 is a
        // vision model and the local runtimes need image inputs.
        const response = await fetch(pdfSource.url, { signal: abortController.signal })
        if (!response.ok) {
          throw new Error(`Unable to load ${pdfSource.filename} (HTTP ${response.status})`)
        }
        const pages = await rasterizePdfToJpegPages(await response.blob(), abortController.signal)
        return pages.map((dataUrl, index) => ({
          type: 'file' as const,
          filename: `page-${index + 1}.jpg`,
          mediaType: 'image/jpeg',
          url: dataUrl,
        }))
      })()
        .catch((caughtError) => {
          sourcePartsPromiseRef.current = null
          throw caughtError
        })
        .finally(() => {
          setAttachingSource(false)
        })
    }

    return sourcePartsPromiseRef.current
  }

  async function send() {
    const text = draft.trim()
    if (!text || status !== 'ready') {
      return
    }

    setLocalError(null)
    try {
      const sourceAlreadyAttached = messages.some((message) =>
        message.parts.some((part) => part.type === 'file'),
      )
      const files = sourceAlreadyAttached ? [] : await sourceFileParts()
      await sendMessage({ text, files })
      setDraft('')
    } catch (caughtError) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
        return
      }
      setLocalError(caughtError instanceof Error ? caughtError.message : 'Unable to send message')
    }
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
        {(localError || error) && (
          <div className="animate-fadeup max-w-[90%] self-start rounded-xl border border-danger/40 bg-surface px-3 py-2 text-xs leading-relaxed text-danger">
            {localError ?? error?.message}
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
