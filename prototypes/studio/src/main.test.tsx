// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { isDeveloperUiEnabled, mountLlmInspector, render } = vi.hoisted(() => ({
  isDeveloperUiEnabled: vi.fn(() => false),
  mountLlmInspector: vi.fn(() => vi.fn()),
  render: vi.fn(),
}))

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render }),
}))
vi.mock('./App.tsx', () => ({ default: () => null }))
vi.mock('./developerUi.ts', () => ({ isDeveloperUiEnabled }))
vi.mock('./llmInspector/mount.tsx', () => ({ mountLlmInspector }))

afterEach(() => {
  document.body.replaceChildren()
  isDeveloperUiEnabled.mockReset()
  isDeveloperUiEnabled.mockReturnValue(false)
  mountLlmInspector.mockClear()
  render.mockClear()
  vi.resetModules()
})

describe('developer UI startup', () => {
  it('removes a stale inspector mount when developer UI is disabled', async () => {
    const root = document.createElement('div')
    root.id = 'root'
    const staleInspector = document.createElement('div')
    staleInspector.id = 'llm-inspector'
    document.body.append(root, staleInspector)

    await import('./main.tsx')

    expect(document.getElementById('llm-inspector')).not.toBeInTheDocument()
    expect(mountLlmInspector).not.toHaveBeenCalled()
  })
})
