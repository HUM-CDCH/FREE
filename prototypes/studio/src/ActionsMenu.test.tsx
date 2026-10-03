// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  return { trigger, open: () => { trigger.focus(); fireEvent.click(trigger) } }
}

const item = (id: string, extra: Partial<ActionItem> = {}): ActionItem => ({ id, label: id, onSelect: vi.fn(), ...extra })

describe('ActionsMenu', () => {
  it('opens from the trigger; its items stay out of the tab order', () => {
    const { trigger, open } = renderMenu([item('First'), item('Second')])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    open()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: 'Schema actions' })).toBeInTheDocument()
    for (const entry of screen.getAllByRole('menuitem')) expect(entry).toHaveAttribute('tabindex', '-1')
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
