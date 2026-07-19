import { ResultValue } from 'free-ui'

const result = {
  site_name: 'Ellekilde',
  excavation_year: 2018,
  museum_no: 'TAK 1355',
  features: [
    { type: 'Posthole', count: 24, dating: 'Bronze Age' },
    { type: 'Pit', count: 7, dating: 'Iron Age' },
  ],
  summary:
    'The excavation at Ellekilde revealed a settlement with several post-built structures and refuse pits spanning two periods.',
  conservation_notes: null,
}

export function ExtractionResult() {
  return (
    <div style={{ width: 440 }}>
      <ResultValue name="Extraction result" value={result} />
    </div>
  )
}
