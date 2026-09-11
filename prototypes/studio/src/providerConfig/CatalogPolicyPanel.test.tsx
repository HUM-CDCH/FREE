// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG_POLICY } from 'extraction/catalog'
import { CatalogPolicyPanel } from './CatalogPolicyPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('loads, edits, saves and reopens all policy settings without restarting', async () => {
  let saved = { ...DEFAULT_CATALOG_POLICY }
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') saved = JSON.parse(String(init.body))
    return Response.json(saved)
  })
  vi.stubGlobal('fetch', request)
  render(<CatalogPolicyPanel />)
  fireEvent.click(screen.getByRole('button', { name: /Catalog policy/ }))
  const size = await screen.findByLabelText('Records per extraction call')
  fireEvent.change(size, { target: { value: '8' } })
  fireEvent.click(screen.getByLabelText('Ask extraction for evidence block citations'))
  fireEvent.click(screen.getByRole('button', { name: 'Save Catalog policy' }))
  await screen.findByText('Catalog policy saved.')
  expect(saved).toMatchObject({ recordBatchSize: 8, citations: true, groundAlways: [] })
  fireEvent.click(screen.getByRole('button', { name: /^Catalog policy/ }))
  fireEvent.click(screen.getByRole('button', { name: /^Catalog policy/ }))
  await waitFor(() => expect(screen.getByLabelText('Records per extraction call')).toHaveValue(8))
})
