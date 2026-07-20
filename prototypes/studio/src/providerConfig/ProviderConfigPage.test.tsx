import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ProviderConfigPage from './ProviderConfigPage'

describe('ProviderConfigPage', () => {
  it('renders the seeded connections with their status', () => {
    const html = renderToStaticMarkup(<ProviderConfigPage />)

    expect(html).toContain('Local Ollama')
    expect(html).toContain('OpenAI (lab key)')
    expect(html).toContain('Connected')
  })

  it('routes each task to its seeded connection and offers that connection\'s models', () => {
    const html = renderToStaticMarkup(<ProviderConfigPage />)

    expect(html).toContain('Extraction')
    expect(html).toContain('Chat')
    // ext -> c1 (Local Ollama), whose models include NuExtract 2.0
    expect(html).toContain('NuExtract 2.0')
    // chat -> c2 (OpenAI), whose models include GPT-4o
    expect(html).toContain('GPT-4o')
    // seed uses two distinct connections, so the header chip should read "Mixed · ready"
    expect(html).toContain('Mixed · ready')
  })
})
