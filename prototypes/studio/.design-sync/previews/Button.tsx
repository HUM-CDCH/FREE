import { Button } from 'free-ui'

const row = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } as const

export function Variants() {
  return (
    <div style={row}>
      <Button variant="primary">Run extraction</Button>
      <Button variant="secondary">Regenerate</Button>
      <Button variant="pill">Generate schema</Button>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={row}>
      <Button variant="primary" size="sm">
        Small
      </Button>
      <Button variant="primary" size="md">
        Run extraction
      </Button>
    </div>
  )
}

export function Disabled() {
  return (
    <div style={row}>
      <Button variant="primary" disabled>
        Generate a schema first
      </Button>
      <Button variant="secondary" disabled>
        Download
      </Button>
    </div>
  )
}
