import { useEffect, useState } from 'react'
import { DEFAULT_CATALOG_POLICY, parseCatalogPolicy, type CatalogPolicy } from 'extraction/catalog'
import { authenticatedFetch } from '../auth/authenticatedFetch'
import { Button } from '../ui'
import { checkedJson } from './providerConfig.data'
import { providerFieldClass } from './ProviderConnectionCard'

const labels: Record<keyof CatalogPolicy, string> = {
  recordBatchSize: 'Records per extraction call',
  groundingGroupSize: 'Records per grounding call',
  wholeSourceDiscoveryMaxChars: 'Whole-document discovery character limit (0 uses page chunks)',
  citations: 'Ask extraction for evidence block citations',
  citationLinks: 'Link locally verified citations without a grounding call',
  groundMultiHit: 'Ground cited values found in multiple blocks',
  groundedContext: 'Include already-linked values as grounding context',
  fieldAwareGrounding: 'Include field names and descriptions in grounding',
  lexicalLinks: 'Link unique text matches without model grounding',
  labelledSlices: 'Label evidence blocks even without requesting citations',
  groundAlways: 'Fields to always ground (comma-separated field paths)',
}

export function CatalogPolicyPanel() {
  const [expanded, setExpanded] = useState(false)
  return <section className="border-t border-line p-4.5">
    <button type="button" aria-expanded={expanded} aria-controls="catalog-policy-editor" className="text-sm font-semibold text-ink" onClick={() => setExpanded(!expanded)}>Catalog policy {expanded ? '−' : '+'}</button>
    {expanded && <CatalogPolicyEditor />}
  </section>
}

function CatalogPolicyEditor() {
  const [draft, setDraft] = useState<CatalogPolicy | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void authenticatedFetch('/api/catalog_policy', { signal: controller.signal })
      .then(checkedJson).then(parseCatalogPolicy).then(setDraft)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Catalog policy could not be loaded.') })
    return () => controller.abort()
  }, [])

  async function save() {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const policy = parseCatalogPolicy({ ...draft, groundAlways: draft!.groundAlways.filter(Boolean) })
      const response = await authenticatedFetch('/api/catalog_policy', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(policy),
      })
      setDraft(parseCatalogPolicy(await checkedJson(response)))
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Catalog policy could not be saved.')
    } finally { setSaving(false) }
  }

  return <div id="catalog-policy-editor" className="mt-3 space-y-3 text-sm">
    <p className="text-ink-muted">Shared across this deployment. Saved settings apply when the next extraction starts, without restarting Studio. Running extractions keep their current settings.</p>
    <p className="text-ink-muted">Local text matches verify occurrence, not meaning. Evidence remains subject to review. “Always ground” and ambiguity routing apply to citations; independent text matching can still link values if enabled.</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {!draft && !error && <p role="status">Loading Catalog policy…</p>}
    {draft && <fieldset disabled={saving} className="space-y-3">
      {(Object.keys(labels) as (keyof CatalogPolicy)[]).map(key => {
        const value = draft[key]
        return <label key={key} className="flex flex-wrap items-center gap-2">
          <span>{labels[key]}</span>
          {typeof value === 'boolean'
            ? <input type="checkbox" checked={value} onChange={event => { setDraft({ ...draft, [key]: event.target.checked }); setSaved(false) }} />
            : <input className={`${providerFieldClass} max-w-sm`} type={typeof value === 'number' ? 'number' : 'text'}
                min={key === 'wholeSourceDiscoveryMaxChars' ? 0 : 1} max={key === 'recordBatchSize' || key === 'groundingGroupSize' ? 50 : undefined} step={1}
                value={Array.isArray(value) ? value.join(', ') : value as number}
                onChange={event => { setDraft({ ...draft, [key]: typeof value === 'number' ? event.target.valueAsNumber : event.target.value.split(',').map(field => field.trim()) }); setSaved(false) }} />}
        </label>
      })}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" onClick={() => void save()}>{saving ? 'Saving…' : 'Save Catalog policy'}</Button>
        <Button size="sm" variant="secondary" onClick={() => { setDraft({ ...DEFAULT_CATALOG_POLICY }); setSaved(false) }}>Use defaults</Button>
        {saved && <span role="status">Catalog policy saved.</span>}
      </div>
    </fieldset>}
  </div>
}
