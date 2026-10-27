import { useCallback, useState } from 'react'
import { mkId } from 'extraction/schema'

/** A chat message before the first schema; one with an `answer` asked a question and is not an instruction. */
export type SchemaInstruction = { id: string; text: string; answer?: string }

export type SchemaInstructions = {
  readonly items: readonly SchemaInstruction[]
  readonly draft: string
  readonly text: string
  readonly count: number
  readonly countLabel: string
  readonly open: boolean
  setDraft(value: string): void
  send(): void
  /** Records a sent message: an instruction, or with `answer` a question and its answer. */
  add(text: string, answer?: string): void
  remove(id: string): void
  toggle(): void
  reset(): void
}

/** Owns the complete pre-generation instruction conversation and drawer state. */
export function useSchemaInstructions(): SchemaInstructions {
  const [items, setItems] = useState<SchemaInstruction[]>([])
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setItems((current) => [...current, { id: mkId(), text }])
  }, [draft])

  const add = useCallback((text: string, answer?: string) => {
    setItems((current) => [...current, { id: mkId(), text, ...(answer === undefined ? {} : { answer }) }])
  }, [])

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((instruction) => instruction.id !== id))
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
    toggle: () => setOpen((current) => !current),
    reset,
  }
}
