import { Overline } from 'free-ui'

export function SectionLabels() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Overline as="h2">Extraction Schema</Overline>
      <Overline as="h3">Annotation Set</Overline>
      <Overline as="h3">Projects</Overline>
    </div>
  )
}
