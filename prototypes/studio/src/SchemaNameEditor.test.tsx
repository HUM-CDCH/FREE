// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('Escape and Cancel close the editor while its rename is saving; the rename goes on, and its answer leaves a reopened editor alone', async () => {
    const answers: Array<(rejected: string | null) => void> = []
    const onSubmit = vi.fn(() => new Promise<string | null>((resolve) => { answers.push(resolve) }))
    render(<SchemaNameEditor name="Places" onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename schema Places' }))
    fireEvent.change(screen.getByLabelText('Schema name for Places'), { target: { value: 'Historic places' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))
    expect(onSubmit).toHaveBeenCalledWith('Historic places')
    // Saving: the name is read-only, not disabled, so it keeps the focus that Escape needs.
    const saving = screen.getByLabelText('Schema name for Places')
    expect(saving).toHaveAttribute('readonly')
    expect(saving).not.toBeDisabled()
    expect(saving).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Save schema name' })).toBeDisabled()
    fireEvent.keyDown(saving, { key: 'Escape' })
    expect(screen.queryByLabelText('Schema name for Places')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename schema Places' })).toBeInTheDocument()

    // Reopened before that rename answered: a fresh session, which its late refusal neither closes nor marks failed.
    fireEvent.click(screen.getByRole('button', { name: 'Rename schema Places' }))
    expect(screen.getByLabelText('Schema name for Places')).not.toHaveAttribute('readonly')
    await act(async () => answers[0]!('Schema storage is unavailable.'))
    expect(screen.getByLabelText('Schema name for Places')).toHaveValue('Places')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Cancel works while saving too.
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Cancel schema rename' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schema rename' }))
    expect(screen.queryByLabelText('Schema name for Places')).not.toBeInTheDocument()
    await act(async () => answers[1]!(null))
    expect(screen.getByRole('button', { name: 'Rename schema Places' })).toBeInTheDocument()
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
