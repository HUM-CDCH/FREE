import { SegmentedControl } from 'free-ui'

const noop = () => {}
const fit = { width: 'fit-content' } as const

export function SchemaView() {
  return (
    <div style={fit}>
      <SegmentedControl
        aria-label="Schema view"
        value="fields"
        onChange={noop}
        options={[
          { value: 'fields', label: 'Fields' },
          { value: 'json', label: '{ }' },
        ]}
      />
    </div>
  )
}

export function ResultView() {
  return (
    <div style={fit}>
      <SegmentedControl
        aria-label="Result view"
        value="review"
        onChange={noop}
        options={[
          { value: 'review', label: 'Review' },
          { value: 'json', label: 'Raw JSON' },
          { value: 'markdown', label: 'Markdown' },
        ]}
      />
    </div>
  )
}

export function Stacked() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
      <SchemaView />
      <ResultView />
    </div>
  )
}
