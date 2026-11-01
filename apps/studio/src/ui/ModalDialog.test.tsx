// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import ModalDialog from './ModalDialog'

afterEach(cleanup)

function Fixture() {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const initial = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={opener} type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <ModalDialog
          className=""
          ariaLabel="Example dialog"
          initialFocusRef={initial}
          returnFocusRef={opener}
          onDismiss={() => setOpen(false)}
        >
          <button ref={initial} type="button">
            Initial
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </ModalDialog>
      )}
    </>
  )
}

it('shares initial focus, Escape dismissal, and exact opener restoration', async () => {
  render(<Fixture />)
  const opener = screen.getByRole('button', { name: 'Open' })
  opener.focus()
  fireEvent.click(opener)

  const dialog = screen.getByRole('dialog', { name: 'Example dialog' })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Initial' })).toHaveFocus(),
  )
  fireEvent(dialog, new Event('cancel', { cancelable: true }))

  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(opener).toHaveFocus()
})

it('Escape in a dialog opened from another dismisses only the inner one', () => {
  const outer = vi.fn()
  const inner = vi.fn()
  render(
    <ModalDialog className="" ariaLabel="Outer dialog" onDismiss={outer}>
      <ModalDialog className="" ariaLabel="Inner dialog" onDismiss={inner}>
        <p>Inner</p>
      </ModalDialog>
    </ModalDialog>,
  )
  fireEvent(screen.getByRole('dialog', { name: 'Inner dialog' }), new Event('cancel', { cancelable: true }))
  expect(inner).toHaveBeenCalledTimes(1)
  expect(outer).not.toHaveBeenCalled()
})

describe('pointer dismissal', () => {
  /** A draft form whose dialog box is 300×200 at (100, 100); `saving` disables dismissal as a pending submit does. */
  function DraftFixture({ saving = false }: { saving?: boolean }) {
    const [open, setOpen] = useState(true)
    return open ? (
      <ModalDialog className="p-5" ariaLabel="Draft dialog" dismissDisabled={saving} onDismiss={() => setOpen(false)}>
        <label>
          Project name <input defaultValue="Draft name" />
        </label>
      </ModalDialog>
    ) : (
      <p>Dismissed</p>
    )
  }
  function renderDraft(saving?: boolean) {
    render(<DraftFixture saving={saving} />)
    const dialog = screen.getByRole('dialog', { name: 'Draft dialog' })
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 100, y: 100, width: 300, height: 200 }))
    return dialog
  }

  it('a click in the dialog padding, whose target is the dialog itself, keeps it open with its draft', () => {
    const dialog = renderDraft()
    fireEvent.click(dialog, { clientX: 105, clientY: 200 })
    fireEvent.click(dialog, { clientX: 399, clientY: 299 })
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('Draft name')
  })

  it('a click on a border pixel at a fractional box edge, reported in whole pixels, keeps it open', () => {
    // Chromium's geometry for the real Studio Home dialog: a trusted click at y 292.5 hits its top border but arrives
    // as clientY 292, and one at y 507.5 on its bottom border arrives as 507.
    render(<DraftFixture />)
    const dialog = screen.getByRole('dialog', { name: 'Draft dialog' })
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 358, y: 292.25, width: 384, height: 215.5 }),
    )
    fireEvent.click(dialog, { clientX: 550, clientY: 292 })
    fireEvent.click(dialog, { clientX: 550, clientY: 507 })
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('Draft name')
    fireEvent.click(dialog, { clientX: 550, clientY: 291 })
    expect(screen.getByText('Dismissed')).toBeInTheDocument()
  })

  it('a click on the backdrop just past a fractional bottom edge dismisses it', () => {
    render(<DraftFixture />)
    const dialog = screen.getByRole('dialog', { name: 'Draft dialog' })
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 358, y: 292.25, width: 384, height: 215.5 }),
    )
    fireEvent.click(dialog, { clientX: 550, clientY: 508 })
    expect(screen.getByText('Dismissed')).toBeInTheDocument()
  })

  it('a click on content keeps it open', () => {
    renderDraft()
    fireEvent.click(screen.getByRole('textbox', { name: 'Project name' }), { clientX: 200, clientY: 200 })
    expect(screen.getByRole('dialog', { name: 'Draft dialog' })).toBeInTheDocument()
  })

  it('a click on the backdrop outside the dialog box dismisses it', () => {
    const dialog = renderDraft()
    fireEvent.click(dialog, { clientX: 10, clientY: 10 })
    expect(screen.getByText('Dismissed')).toBeInTheDocument()
  })

  it('while saving, neither the backdrop, the padding nor Escape dismisses it', () => {
    const dialog = renderDraft(true)
    fireEvent.click(dialog, { clientX: 10, clientY: 10 })
    fireEvent.click(dialog, { clientX: 105, clientY: 200 })
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('Draft name')
  })
})
