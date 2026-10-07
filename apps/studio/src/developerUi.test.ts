import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDeveloperUiEnabled } from './developerUi'

describe('isDeveloperUiEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is disabled by default when VITE_SHOW_DEVELOPER_UI is not set', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', '')
    expect(isDeveloperUiEnabled()).toBe(false)
  })

  it('is enabled when VITE_SHOW_DEVELOPER_UI=true', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', 'true')
    expect(isDeveloperUiEnabled()).toBe(true)
  })

  it('is disabled when VITE_SHOW_DEVELOPER_UI is set to other values', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', 'false')
    expect(isDeveloperUiEnabled()).toBe(false)
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', '1')
    expect(isDeveloperUiEnabled()).toBe(false)
  })
})
