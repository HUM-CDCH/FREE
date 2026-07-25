import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ProviderConfigPage from './ProviderConfigPage'

describe('ProviderConfigPage', () => {
  it('starts from backend-owned loading state without fabricated connections or secrets', () => {
    const html = renderToStaticMarkup(<ProviderConfigPage onClose={() => {}} />)
    expect(html).toContain('Loading model configuration')
    expect(html).not.toContain('sk-live')
    expect(html).not.toContain('Local Ollama')
    expect(html).not.toContain('type="password"')
  })
})
