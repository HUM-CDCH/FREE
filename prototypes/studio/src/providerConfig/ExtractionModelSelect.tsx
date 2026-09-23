import type { ExtractionModelListing, ExtractionModelRole } from '../../shared/extraction.contract'

const ROLE_TEXT: Readonly<Record<ExtractionModelRole, { label: string; name: string; title: string }>> = {
  fields: {
    label: 'Fields',
    name: 'Field model',
    title: 'The model that reads field values off the source, for every extraction',
  },
  reasoning: {
    label: 'Reasoning',
    name: 'Reasoning model',
    title: 'The model that decides where records start, which passage grounds a value, and between competing candidates',
  },
}

/**
 * One role of the deployment-wide Extraction Model Choice: kei-exp's default ('') or one of the deployment's models that
 * can take the role. Without a listing only the default is offered, and a run is never blocked on it.
 */
export function ExtractionModelSelect({
  role,
  listing,
  value,
  disabled,
  onChange,
}: {
  role: ExtractionModelRole
  listing: ExtractionModelListing | null
  value: string
  disabled: boolean
  onChange: (key: string) => void
}) {
  const text = ROLE_TEXT[role]
  const defaultKey = listing?.defaults[role]
  const defaultRepo = listing?.models.find((model) => model.key === defaultKey)?.repo ?? defaultKey
  const choices = listing?.models.filter((model) => model.roles.includes(role)) ?? []
  // A running attempt keeps showing its own choice even when the listing no longer offers it.
  const unlisted = value !== '' && !choices.some((model) => model.key === value)
  return (
    <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-muted">
      {text.label}
      <select
        aria-label={text.name}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        title={text.title}
        className="max-w-48 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
      >
        <option value="">{defaultRepo ? `Default (${defaultRepo})` : 'Default'}</option>
        {choices.map((model) => (
          <option key={model.key} value={model.key}>
            {model.serving ? model.repo : `${model.repo} (unavailable)`}
          </option>
        ))}
        {unlisted && <option value={value}>{value}</option>}
      </select>
    </label>
  )
}
