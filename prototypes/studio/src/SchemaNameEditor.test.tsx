// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SchemaNameEditor from './SchemaNameEditor'

afterEach(cleanup)

describe('SchemaNameEditor', () => {
  it('renames inside the same fixed-height slot', async () => {
    const onSubmit = vi.fn(async () => null)
    const { container, rerender } = render(
      <SchemaNameEditor name="Places" onSubmit={onSubmit} />,
    )
    expect(container.firstElementChild).toHaveClass('h-7')

    fireEvent.click(screen.getByRole('button', { name: 'Rename schema Places' }))
    expect(container.firstElementChild).toHaveClass('h-7')
    fireEvent.change(screen.getByLabelText('Schema name for Places'), {
      target: { value: ' Historic places ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Historic places'))
    rerender(
      <SchemaNameEditor name="Historic places" onSubmit={onSubmit} />,
    )
    expect(
      await screen.findByRole('button', {
        name: 'Rename schema Historic places',
      }),
    ).toBeInTheDocument()
  })

  it('keeps a failed save in an overlaid alert without changing its height', async () => {
    render(
      <SchemaNameEditor
        name="Places"
        onSubmit={vi.fn(async () => 'Schema storage is unavailable.')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename schema Places' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Schema storage is unavailable.',
    )
    expect(screen.getByRole('alert')).toHaveClass('absolute')
    expect(screen.getByRole('alert').closest('form')).toHaveClass('h-7')
  })
})
