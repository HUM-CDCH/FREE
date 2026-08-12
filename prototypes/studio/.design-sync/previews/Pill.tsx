import { Pill } from 'free-ui'

const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as const

export function Tones() {
  return (
    <div style={row}>
      <Pill tone="neutral">verbatim-string</Pill>
      <Pill tone="accent">12 fields</Pill>
      <Pill tone="evidence">Evidence</Pill>
      <Pill tone="success">Approved</Pill>
      <Pill tone="stale">Stale</Pill>
    </div>
  )
}

export function Outline() {
  return (
    <div style={row}>
      <Pill tone="neutral" outline>
        Status: ready
      </Pill>
      <Pill tone="success" outline>
        Missing: 0
      </Pill>
      <Pill tone="stale" outline>
        Re-run needed
      </Pill>
    </div>
  )
}
