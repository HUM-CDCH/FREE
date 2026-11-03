import { useCallback, useEffect, useRef, useState } from 'react'
import { mkId } from 'extraction/schema'
import type { ChatHistory } from '../shared/schemaChat.contract'

/** A chat message before the first schema; one with an `answer` asked a question and is not an instruction. */
export type SchemaInstruction = { id: string; text: string; answer?: string }

export type SchemaInstructions = {
  readonly items: readonly SchemaInstruction[]
  readonly draft: string
  readonly text: string
  /** The conversation as the model reads it: each message, then its answer or that it was kept as an instruction. */
  readonly history: ChatHistory
  readonly count: number
  readonly countLabel: string
  readonly open: boolean
  setDraft(value: string): void
  send(): void
  /** Records a sent message: an instruction, or with `answer` a question and its answer. Returns what it recorded. */
  add(text: string, answer?: string): SchemaInstruction
  remove(id: string): void
  /** Puts back what an earlier visit recorded, ahead of anything recorded since. */
  restore(items: readonly SchemaInstruction[]): void
  toggle(): void
  reset(): void
}

/** Owns the complete pre-generation instruction conversation and drawer state; `onAdd` and `onRemove` hear each item
 *  recorded or taken back. */
export function useSchemaInstructions({ onAdd, onRemove }: {
  onAdd?: (item: SchemaInstruction) => void
  onRemove?: (id: string) => void
} = {}): SchemaInstructions {
  const [items, setItems] = useState<SchemaInstruction[]>([])
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)

  const listeners = useRef({ onAdd, onRemove })
  useEffect(() => { listeners.current = { onAdd, onRemove } })
  const add = useCallback((text: string, answer?: string) => {
    const item = { id: mkId(), text, ...(answer === undefined ? {} : { answer }) }
    setItems((current) => [...current, item])
    listeners.current.onAdd?.(item)
    return item
  }, [])

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    add(text)
  }, [add, draft])

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((instruction) => instruction.id !== id))
    listeners.current.onRemove?.(id)
  }, [])

  const restore = useCallback((restored: readonly SchemaInstruction[]) => {
    setItems((current) => [...restored.filter(({ id }) => !current.some((item) => item.id === id)), ...current])
  }, [])

  const reset = useCallback(() => {
    setItems([])
    setDraft('')
    setOpen(false)
  }, [])

  const kept = items.filter((item) => item.answer === undefined)
  return {
    items,
    draft,
    text: kept.map((instruction) => instruction.text).join('\n\n'),
    history: items.flatMap((item): ChatHistory => [
      { role: 'user', text: item.text },
      { role: 'assistant', text: item.answer ?? 'Recorded as an instruction for template generation.' },
    ]),
    count: kept.length,
    countLabel:
      kept.length > 0
        ? ` (${kept.length} message${kept.length === 1 ? '' : 's'})`
        : '',
    open,
    setDraft,
    send,
    add,
    remove,
    restore,
    toggle: () => setOpen((current) => !current),
    reset,
  }
}
