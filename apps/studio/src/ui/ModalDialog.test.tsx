// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
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
