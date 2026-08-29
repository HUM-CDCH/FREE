// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelCombobox } from './ModelCombobox'

afterEach(cleanup)

it('uses the first Escape for the listbox and the second for its parent dialog', () => {
  const closeParent = vi.fn()
  render(
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape') closeParent()
      }}
    >
      <ModelCombobox
        value=""
        onChange={() => {}}
        options={[{ id: 'exact/model', label: 'Exact model' }]}
        probePhase="done"
        ariaLabel="Extraction model ID"
      />
    </div>,
  )

  const input = screen.getByRole('combobox', {
    name: 'Extraction model ID',
  })
  fireEvent.focus(input)
  expect(input).toHaveAttribute('aria-expanded', 'true')

  fireEvent.keyDown(input, { key: 'Escape' })
  expect(input).toHaveAttribute('aria-expanded', 'false')
  expect(closeParent).not.toHaveBeenCalled()

  fireEvent.keyDown(input, { key: 'Escape' })
  expect(closeParent).toHaveBeenCalledTimes(1)
})

it('navigates options and preserves exact free-form model IDs', () => {
  const onChange = vi.fn()
  render(
    <ModelCombobox
      value=""
      onChange={onChange}
      options={[
        { id: 'model/a', label: 'Model A' },
        { id: 'model/b', label: 'Model B' },
      ]}
      probePhase="done"
      ariaLabel="Interaction model ID"
    />,
  )

  const input = screen.getByRole('combobox', {
    name: 'Interaction model ID',
  })
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(input).toHaveAttribute('aria-activedescendant')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onChange).toHaveBeenCalledWith('model/a')

  fireEvent.change(input, { target: { value: '  exact/custom:model  ' } })
  expect(onChange).toHaveBeenLastCalledWith('  exact/custom:model  ')
})
