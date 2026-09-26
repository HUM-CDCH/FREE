// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker, type PickerGroup } from './ModelPicker'

const connections: PickerGroup[] = [
  {
    key: 'deployment',
    label: 'Deployment instruction model',
    options: [{ value: 'deployment:Qwen/Qwen3.8-27B-FP8', label: 'Qwen/Qwen3.8-27B-FP8' }],
    freeText: (typed) => `deployment:${typed}`,
  },
  {
    key: 'ollama',
    label: 'Local Ollama',
    note: 'Listing models…',
    options: [
      { value: 'ollama:llama3.3', label: 'llama3.3' },
      { value: 'ollama:qwen3:8b', label: 'qwen3:8b' },
    ],
    freeText: (typed) => `ollama:${typed}`,
  },
]

function renderPicker(groups: PickerGroup[], reset?: { value: string; label: string }) {
  const onChange = vi.fn()
  render(
    <ModelPicker ariaLabel="Assistant model" value="" display="Deployment default" groups={groups} reset={reset} onChange={onChange} />,
  )
  return onChange
}

const optionNames = (container: HTMLElement) => within(container).queryAllByRole('option').map((option) => option.textContent)

afterEach(() => {
  cleanup()
})

describe('ModelPicker', () => {
  it('groups options by connection, searches, and offers an exact model ID', () => {
    const onChange = renderPicker(connections, { value: '', label: 'Deployment default' })
    const trigger = screen.getByRole('button', { name: 'Assistant model' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('Deployment default')

    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox', { name: 'Assistant model' })
    const deployment = within(listbox).getByRole('group', { name: 'Deployment instruction model' })
    const ollama = within(listbox).getByRole('group', { name: 'Local Ollama' })
    expect(optionNames(deployment)).toEqual(['Qwen/Qwen3.8-27B-FP8'])
    expect(optionNames(ollama)).toEqual(['llama3.3', 'qwen3:8b'])
    expect(ollama).toHaveTextContent('Listing models…')
    expect(within(listbox).getByRole('option', { name: 'Deployment default' })).toHaveAttribute('aria-selected', 'true')

    const search = screen.getByRole('combobox')
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: 'qwen' } })
    expect(within(listbox).queryByRole('option', { name: 'Deployment default' })).not.toBeInTheDocument()
    expect(optionNames(deployment)).toEqual(['Qwen/Qwen3.8-27B-FP8', 'Use qwen'])
    expect(optionNames(ollama)).toEqual(['qwen3:8b', 'Use qwen'])

    // A listed model is not offered again as typed text in its own group.
    fireEvent.change(search, { target: { value: 'llama3.3' } })
    expect(optionNames(ollama)).toEqual(['llama3.3'])
    expect(optionNames(deployment)).toEqual(['Use llama3.3'])

    fireEvent.change(search, { target: { value: ' my-org/exact-model ' } })
    expect(optionNames(ollama)).toEqual(['Use my-org/exact-model'])
    fireEvent.click(within(ollama).getByRole('option', { name: 'Use my-org/exact-model' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('ollama:my-org/exact-model')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('disabled options cannot be chosen', () => {
    const onChange = renderPicker([
      {
        key: 'ocr',
        label: 'OCR models this deployment knows',
        options: [
          { value: 'granite_vision', label: 'ibm-granite/granite-vision-4.1-4b', hint: 'Not loaded on the OCR server', disabled: true },
          { value: 'surya', label: 'datalab-to/surya-ocr-2' },
        ],
      },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Assistant model' }))
    const unloaded = screen.getByRole('option', { name: /granite-vision/ })
    expect(unloaded).toHaveAttribute('aria-disabled', 'true')
    expect(unloaded).toHaveTextContent('Not loaded on the OCR server')

    fireEvent.click(unloaded)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    // The keyboard skips it too.
    const search = screen.getByRole('combobox')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /surya/ }).id)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /surya/ }).id)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('surya')
  })

  it('Escape closes it and returns focus to the trigger', () => {
    const onChange = renderPicker(connections)
    const trigger = screen.getByRole('button', { name: 'Assistant model' })
    fireEvent.click(trigger)
    const search = screen.getByRole('combobox')
    fireEvent.change(search, { target: { value: 'qwen' } })

    // Handled here, so an enclosing dialog does not take the Escape as its own dismissal.
    expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(false)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(onChange).not.toHaveBeenCalled()

    // It reopens without the old search.
    fireEvent.click(trigger)
    expect(screen.getByRole('combobox')).toHaveValue('')
  })
})
