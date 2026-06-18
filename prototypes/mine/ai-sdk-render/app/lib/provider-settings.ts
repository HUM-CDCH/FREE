export type AiProviderKind = 'ollama' | 'docker-runner'

export type AiProviderSettings = {
  provider: AiProviderKind
  baseURL: string
  model: string
}

export const DEFAULT_PROVIDER_SETTINGS: Record<AiProviderKind, AiProviderSettings> = {
  ollama: {
    provider: 'ollama',
    baseURL: 'http://127.0.0.1:11434',
    model: 'nuextract',
  },
  'docker-runner': {
    provider: 'docker-runner',
    baseURL: 'http://127.0.0.1:12434/engines/v1',
    model: 'hf.co/numind/NuExtract3-GGUF:mmproj',
  },
}

export const DEFAULT_PROVIDER = DEFAULT_PROVIDER_SETTINGS.ollama

export function normalizeProviderSettings(value: unknown): AiProviderSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_PROVIDER
  }

  const record = value as Record<string, unknown>
  const provider = record.provider === 'docker-runner' ? 'docker-runner' : 'ollama'
  const defaults = DEFAULT_PROVIDER_SETTINGS[provider]

  return {
    provider,
    baseURL: typeof record.baseURL === 'string' && record.baseURL.trim() ? record.baseURL.trim() : defaults.baseURL,
    model: typeof record.model === 'string' && record.model.trim() ? record.model.trim() : defaults.model,
  }
}
