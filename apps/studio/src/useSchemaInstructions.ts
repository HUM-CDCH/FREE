import { useCallback, useState } from 'react'
import { mkId } from 'extraction/schema'

export type SchemaInstruction = { id: string; text: string }

export type SchemaInstructions = {
  readonly items: readonly SchemaInstruction[]
  readonly draft: string
  readonly text: string
  readonly count: number
  readonly countLabel: string
  readonly open: boolean
  setDraft(value: string): void
  send(): void
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

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((instruction) => instruction.id !== id))
  }, [])

  const reset = useCallback(() => {
    setItems([])
    setDraft('')
    setOpen(false)
  }, [])

  return {
    items,
    draft,
    text: items.map((instruction) => instruction.text).join('\n\n'),
    count: items.length,
    countLabel:
      items.length > 0
        ? ` (${items.length} message${items.length === 1 ? '' : 's'})`
        : '',
    open,
    setDraft,
    send,
    remove,
    toggle: () => setOpen((current) => !current),
    reset,
  }
}
