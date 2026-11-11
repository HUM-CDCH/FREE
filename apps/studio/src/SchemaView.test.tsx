// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SchemaView from './SchemaView'
import type { SchemaDefinition } from 'extraction/schema'
const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('./api', () => ({ listModelOperations: list }))
afterEach(cleanup)
it('reads historical definitions verbatim without model recovery or editing capabilities', () => {
  const definition: SchemaDefinition = { recordDescription: '', schemaNodes: [
    { id: 'parent', name: 'record', type: 'object', children: [
      { id: 'child', name: 'file', type: 'string', valueSource: 'source-filename', description: 'Historical notes.' },
    ] },
  ] }
  render(<SchemaView definition={definition} recordScope="records" />)
  expect(screen.queryByRole('button', { name: 'Edit file' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse record' }))
  expect(screen.queryByRole('listitem', { name: 'file' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Expand record' }))
  expect(screen.getByRole('listitem', { name: 'file' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Code' }))
  expect(screen.getByText(/"source-filename"/)).toHaveTextContent('"id": "child"')
  expect(list).not.toHaveBeenCalled()
  expect(definition.recordDescription).toBe('')
})
