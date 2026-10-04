export type KeyAction =
  | 'cancel-edit' | 'close-dialog' | 'close-drawer' | 'close-menu' | 'leave'
  | 'save-edit' | 'undo' | 'approve' | 'edit' | 'reject' | 'next' | 'previous'

/** What the rail knows when a key arrives (results review redesign §4.4). */
export type KeyContext = {
  /** A record is readable: before that only Escape is handled. */
  readable: boolean
  /** The review is being saved: decisions and keys wait. */
  saving: boolean
  editing: boolean
  dialog: boolean
  drawer: boolean
  menu: boolean
  /** One-by-one is on. */
  oneByOne: boolean
  canUndo: boolean
  /** The current one-by-one value: undecided, decided, or none (an end card). */
  current: 'open' | 'decided' | null
}

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * The rail's keyboard model: keys act only while focus is within the rail, never on repeat or with a modifier, never
 * while typing (except Enter, which saves an open edit, and Escape). Escape closes the first that applies: the edit, the
 * Approve rest… dialog, the Run details drawer, the ⋯ menu, then one-by-one.
 */
export function keyAction(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey'> & { target: EventTarget | null },
  context: KeyContext): KeyAction | null {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Escape') {
    if (context.editing) return 'cancel-edit'
    if (context.dialog) return 'close-dialog'
    if (context.drawer) return 'close-drawer'
    if (context.menu) return 'close-menu'
    return context.oneByOne ? 'leave' : null
  }
  if (!context.readable || context.saving) return null
  const typing = event.target instanceof Element && TYPING.has(event.target.tagName)
  if (typing) return event.key === 'Enter' && context.editing ? 'save-edit' : null
  const key = event.key.toLowerCase()
  if (key === 'z') return context.canUndo ? 'undo' : null
  if (!context.oneByOne || context.editing) return null
  if (key === 'j') return 'next'
  if (key === 'k') return context.current ? 'previous' : null
  if (context.current !== 'open') return null
  return key === 'a' ? 'approve' : key === 'e' ? 'edit' : key === 'r' ? 'reject' : null
}
