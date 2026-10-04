// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { keyAction, type KeyContext } from './reviewKeys'

const base: KeyContext = { readable: true, saving: false, editing: false, dialog: false, drawer: false, menu: false, oneByOne: true, canUndo: true, current: 'open' }
const press = (key: string, context: Partial<KeyContext> = {}, extra: Partial<KeyboardEvent> = {}, target: Element = document.body) =>
  keyAction({ key, repeat: false, altKey: false, ctrlKey: false, metaKey: false, ...extra, target }, { ...base, ...context })

describe('the rail keyboard model (results review redesign §4.4)', () => {
  it('A E R decide the current undecided value; J skips; K steps back; Z undoes', () => {
    expect(['a', 'E', 'r', 'j', 'k', 'z'].map((key) => press(key))).toEqual(['approve', 'edit', 'reject', 'next', 'previous', 'undo'])
    expect(press('a', { current: 'decided' })).toBeNull()
    expect(press('j', { current: 'decided' })).toBe('next')
  })

  it('ignores repeats, modifiers, and typing, except Enter on an open edit', () => {
    expect(press('a', {}, { repeat: true })).toBeNull()
    expect(press('a', {}, { ctrlKey: true })).toBeNull()
    expect(press('z', {}, { metaKey: true })).toBeNull()
    const input = document.createElement('input')
    expect(press('a', {}, {}, input)).toBeNull()
    expect(press('Enter', { editing: true }, {}, input)).toBe('save-edit')
    expect(press('Enter', {}, {}, input)).toBeNull()
  })

  it('Escape closes the first that applies: edit, dialog, drawer, menu, one-by-one; otherwise nothing', () => {
    expect(press('Escape', { editing: true, dialog: true, drawer: true, menu: true })).toBe('cancel-edit')
    expect(press('Escape', { dialog: true, drawer: true, menu: true })).toBe('close-dialog')
    expect(press('Escape', { drawer: true, menu: true })).toBe('close-drawer')
    expect(press('Escape', { menu: true })).toBe('close-menu')
    expect(press('Escape')).toBe('leave')
    expect(press('Escape', { oneByOne: false })).toBeNull()
  })

  it.each(['dialog', 'drawer', 'menu'] as const)('%s suspends review shortcuts while it owns focus', (overlay) => {
    for (const key of ['a', 'e', 'r', 'j', 'k', 'z']) expect(press(key, { [overlay]: true })).toBeNull()
    expect(press('Escape', { [overlay]: true })).not.toBeNull()
  })

  it('in the list only Z acts; before a record is read, or while saving, only Escape', () => {
    expect(press('a', { oneByOne: false })).toBeNull()
    expect(press('z', { oneByOne: false })).toBe('undo')
    expect(press('z', { canUndo: false })).toBeNull()
    expect(press('z', { readable: false })).toBeNull()
    expect(press('a', { saving: true })).toBeNull()
    expect(press('Escape', { readable: false, menu: true })).toBe('close-menu')
  })
})
