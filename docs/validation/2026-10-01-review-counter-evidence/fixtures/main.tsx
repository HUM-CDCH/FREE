import React from 'react'
import { createRoot } from 'react-dom/client'
import ResultsTab from '/@fs/home/gebbaro/Progetti/FREE/prototypes/studio/src/ResultsTab.tsx'
import { useExtraction } from '/@fs/home/gebbaro/Progetti/FREE/prototypes/studio/src/useExtraction.ts'
import './style.css'

const initial = await fetch('/fixture/attempt').then(response => response.json())
const schema = { recordDescription: 'One place.', schemaNodes: [
  { id: 'place', name: 'place', type: 'string' }, { id: 'year', name: 'year', type: 'integer' },
] }
function Fixture() {
  const controller = useExtraction({ initialAttempt: initial, schemaReady: true, indexing: false,
    reviewTarget: { sourceRepresentationId: initial.sourceRepresentationRevisionId, schemaRevisionId: initial.schemaRevisionId },
    onTerminal: () => {}, onError: () => {}, documentKey: 'fixture',
  })
  return <main style={{ height: '100dvh', width: 'min(100%, 440px)', margin: '0 auto', background: 'white' }}>
    <ResultsTab controller={controller} schemaReady documentMarkdown="# Source" sourceDocumentName="counter-fixture.pdf"
      pinnedSchema={schema} exportSchema={schema} runExtractionDisabled runExtractionStrategy={{ strategy: 'ARTICLE' }} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
