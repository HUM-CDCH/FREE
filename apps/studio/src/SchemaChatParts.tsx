import type { ReactNode } from 'react'
import type { SchemaChat } from './useSchemaChat'
import { chatMessageClass } from './chatMessageClass'

/** The label over the chat composer, before and after the first schema alike. */
export function ChatLabel({ optional = false }: { optional?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-overline font-bold uppercase tracking-[0.12em] text-ink-muted">Chat</span>
      {optional && <span className="rounded bg-canvas px-1.5 py-0.5 text-overline font-semibold uppercase tracking-wide text-ink-faint">Optional</span>}
    </span>
  )
}

/** Requests a reload found still running, each with its Stop. */
export function RunningRequests({ recovery }: { recovery: SchemaChat['recovery'] }) {
  return recovery.running.map((operation) => (
    <div
      key={operation.workflowId}
      className="flex items-center justify-between gap-2 rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-2 text-secondary text-ink-muted"
    >
      <span>{`Still working on an earlier request: “${operation.instruction}”`}</span>
      <button
        type="button"
        className="min-h-6 shrink-0 cursor-pointer text-compact text-ink underline"
        aria-label={`Stop earlier request “${operation.instruction}”`}
        onClick={() => recovery.stop(operation.workflowId)}
      >
        Stop
      </button>
    </div>
  ))
}

/** The edit chat's conversation: running requests, the messages and answered steps, and a reply on its way. */
export function ChatTranscript({ chat, empty, before }: { chat: SchemaChat; empty: string; before?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <RunningRequests recovery={chat.recovery} />
      {before}
      {chat.messages.length === 0 && chat.recovery.running.length === 0 && !chat.loading && !before && (
        <p className="text-secondary leading-relaxed text-ink-faint">{empty}</p>
      )}
      {chat.messages.map((message, index) => message.role === 'step' ? (
        // An answered step folds to one line: what was asked and what the researcher chose.
        <p key={index} className="flex min-w-0 items-baseline gap-1.5 self-stretch text-compact text-ink-muted">
          <span aria-hidden="true" className="text-green">✓</span>
          <span className="min-w-0 truncate"><span className="font-semibold text-ink">{message.title}</span> · {message.choice}</span>
        </p>
      ) : (
        <div key={index} className={chatMessageClass(message.role)}>{message.text}</div>
      ))}
      {chat.loading && (
        <div className="self-start rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-2">
          <span className="flex gap-1">
            <span className="animate-pulse text-content text-ink-faint">•</span>
            <span className="animate-pulse text-content text-ink-faint" style={{ animationDelay: '0.15s' }}>•</span>
            <span className="animate-pulse text-content text-ink-faint" style={{ animationDelay: '0.3s' }}>•</span>
          </span>
        </div>
      )}
    </div>
  )
}
