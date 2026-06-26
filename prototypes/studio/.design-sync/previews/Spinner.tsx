import { Spinner } from 'free-ui'

export function Labeled() {
  return (
    <div style={{ width: 280 }}>
      <Spinner label="Producing schema…" hint="This can take a while on large documents." />
    </div>
  )
}

export function Bare() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Spinner />
    </div>
  )
}
