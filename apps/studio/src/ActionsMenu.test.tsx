// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActionsMenu, { type ActionItem } from './ActionsMenu'

afterEach(cleanup)

function renderMenu(items: ActionItem[]) {
  render(
    <>
      <ActionsMenu label="Schema actions" items={items} />
      <button type="button">Outside</button>
    </>,
  )
  const trigger = screen.getByRole('button', { name: 'Schema actions' })
  // A pointer click carries its click count in `detail`.
  return { trigger, open: () => { trigger.focus(); fireEvent.click(trigger, { detail: 1 }) } }
}

/** Enter or Space on a focused button: the browser clicks it with `detail` 0. */
function pressToOpen(trigger: HTMLElement, key: 'Enter' | ' ') {
  trigger.focus()
  fireEvent.keyDown(trigger, { key })
  fireEvent.click(trigger, { detail: 0 })
}

const item = (id: string, extra: Partial<ActionItem> = {}): ActionItem => ({ id, label: id, onSelect: vi.fn(), ...extra })

describe('ActionsMenu', () => {
  it('lines the list up with the trigger\'s right edge by default, and with its left edge when aligned left', () => {
    const { open } = renderMenu([item('First')])
    open()
    expect(screen.getByRole('menu')).toHaveClass('right-0')
    expect(screen.getByRole('menu')).not.toHaveClass('left-0')
    cleanup()
    render(<ActionsMenu label="Project actions" align="left" items={[item('Back')]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Project actions' }), { detail: 1 })
    expect(screen.getByRole('menu')).toHaveClass('left-0')
    expect(screen.getByRole('menu')).not.toHaveClass('right-0')
  })

  it('opens from the trigger; its items stay out of the tab order', () => {
    const { trigger, open } = renderMenu([item('First'), item('Second')])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    open()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: 'Schema actions' })).toBeInTheDocument()
    for (const entry of screen.getAllByRole('menuitem')) expect(entry).toHaveAttribute('tabindex', '-1')
  })

  it.each([['Enter', 'Enter'], ['Space', ' ']] as const)(
    '%s on the trigger opens with the first enabled item focused; Tab then leaves and closes',
    (_name, key) => {
      const { trigger } = renderMenu([item('First', { disabled: true }), item('Second'), item('Third')])
      pressToOpen(trigger, key)
      expect(screen.getByRole('menuitem', { name: 'Second' })).toHaveFocus()
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
      expect(screen.getByRole('menuitem', { name: 'Third' })).toHaveFocus()

      // Tab moves focus past the menu to the next control, which closes it without pulling focus back.
      const outside = screen.getByRole('button', { name: 'Outside' })
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
      act(() => outside.focus())
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(outside).toHaveFocus()
    },
  )

  it('a keyboard open with no enabled item keeps focus on the trigger, and Escape still closes', () => {
    const { trigger } = renderMenu([item('Only', { disabled: true })])
    pressToOpen(trigger, 'Enter')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('a pointer open leaves focus on the trigger', () => {
    const { trigger, open } = renderMenu([item('First')])
    open()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('selecting a keyboard-focused item with Enter calls onSelect, closes and returns focus to the trigger', () => {
    const second = item('Second')
    const { trigger } = renderMenu([item('First'), second])
    pressToOpen(trigger, 'Enter')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.click(document.activeElement!, { detail: 0 })
    expect(second.onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('ArrowDown from the trigger focuses the first item, ArrowUp the last, and the arrows wrap', () => {
    const { trigger, open } = renderMenu([item('First'), item('Second'), item('Third')])
    open()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(screen.getByRole('menuitem', { name: 'Third' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus()

    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(screen.getByRole('menuitem', { name: 'Third' })).toHaveFocus()
  })

  it('skips a disabled item', () => {
    const { trigger, open } = renderMenu([item('First'), item('Second', { disabled: true }), item('Third')])
    open()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Third' })).toHaveFocus()
  })

  it('Escape closes and returns focus to the trigger', () => {
    const { trigger, open } = renderMenu([item('First')])
    open()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('an outside pointer press closes the menu; one inside does not', () => {
    const { open } = renderMenu([item('First')])
    open()
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'First' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('selecting an item calls onSelect and closes', () => {
    const first = item('First')
    const { trigger, open } = renderMenu([first])
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'First' }))
    expect(first.onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
