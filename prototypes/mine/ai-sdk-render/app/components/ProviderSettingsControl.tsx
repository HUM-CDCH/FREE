import {
  DEFAULT_PROVIDER_SETTINGS,
  type AiProviderKind,
  type AiProviderSettings,
} from '../lib/provider-settings'

type ProviderSettingsControlProps = {
  value: AiProviderSettings
  onChange: (value: AiProviderSettings) => void
}

function ProviderSettingsControl({ value, onChange }: ProviderSettingsControlProps) {
  function changeProvider(provider: AiProviderKind) {
    onChange(DEFAULT_PROVIDER_SETTINGS[provider])
  }

  return (
    <div className="hidden min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface-muted px-2 py-1 lg:flex">
      <select
        className="max-w-34 rounded-md border border-line bg-surface px-1.5 py-1 text-[11px] font-semibold text-ink outline-none focus-visible:border-accent"
        value={value.provider}
        title="AI SDK provider"
        onChange={(event) => changeProvider(event.target.value as AiProviderKind)}
      >
        <option value="ollama">Ollama</option>
        <option value="docker-runner">Docker Runner</option>
      </select>
      <input
        className="w-48 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
        value={value.baseURL}
        title="Provider base URL"
        onChange={(event) => onChange({ ...value, baseURL: event.target.value })}
      />
      <input
        className="w-52 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
        value={value.model}
        title="Model"
        onChange={(event) => onChange({ ...value, model: event.target.value })}
      />
    </div>
  )
}

export default ProviderSettingsControl
