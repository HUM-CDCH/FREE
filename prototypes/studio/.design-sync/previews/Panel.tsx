import { Panel, Overline, Button, Pill } from 'free-ui'

const field = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  color: 'var(--color-ink)',
} as const

export function SchemaPanel() {
  return (
    <div
      style={{
        height: 340,
        width: 380,
        border: '1px solid var(--color-line)',
        borderRadius: 12,
        overflow: 'hidden',
        background: 'var(--color-surface)',
      }}
    >
      <Panel
        header={
          <>
            <Overline as="h2">Extraction Schema</Overline>
            <Pill tone="accent">4 fields</Pill>
          </>
        }
        footer={
          <>
            <span style={{ fontSize: 11, color: 'var(--color-ink-faint)' }}>
              4 fields · produced from the document
            </span>
            <Button variant="pill">Regenerate</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={field}>
            site_name <Pill tone="neutral">string</Pill>
          </div>
          <div style={field}>
            excavation_year <Pill tone="neutral">number</Pill>
          </div>
          <div style={field}>
            features <Pill tone="neutral">list</Pill>
          </div>
          <div style={field}>
            summary <Pill tone="neutral">verbatim-string</Pill>
          </div>
        </div>
      </Panel>
    </div>
  )
}
