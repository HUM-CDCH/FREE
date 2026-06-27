import { EmptyState, Button } from 'free-ui'

export function NoSchema() {
  return (
    <div style={{ width: 360 }}>
      <EmptyState
        title="No schema yet"
        description="FREE produces the extraction schema from the document with the extraction model."
      >
        <Button variant="pill">Generate schema</Button>
      </EmptyState>
    </div>
  )
}

export function Annotate() {
  return (
    <div style={{ width: 360 }}>
      <EmptyState
        icon="✎"
        title="Annotate the source"
        description="Select any passage in the report — it becomes a grounded annotation in the set."
      />
    </div>
  )
}

export function Failed() {
  return (
    <div style={{ width: 360 }}>
      <EmptyState
        tone="danger"
        title="Extraction failed"
        description="The extraction model returned an invalid response for this document."
      >
        <Button variant="pill">Retry extraction</Button>
      </EmptyState>
    </div>
  )
}
