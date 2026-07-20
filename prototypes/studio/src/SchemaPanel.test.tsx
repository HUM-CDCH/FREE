import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SchemaPanel from './SchemaPanel'
import { burialFindsPinnedSchema, pinnedSchemas } from './pinnedSchemas'
import { templateToNodes } from './schemaNode'
import { schemaMetadata } from './schemaState'

describe('SchemaPanel pinned schemas', () => {
  it('exposes Burial Finds as the selected read-only production schema', () => {
    const html = renderToStaticMarkup(
      createElement(SchemaPanel, {
        state: {
          status: 'ready',
			schema: schemaMetadata(burialFindsPinnedSchema.schema),
          nodes: templateToNodes(burialFindsPinnedSchema.schema.record),
          inputsKey: '',
          source: 'pinned',
          pinnedSchemaId: 'FieldReports/Burial_Finds',
        },
        stale: false,
        pinnedSchemas,
        selectedPinnedSchemaId: 'FieldReports/Burial_Finds',
        onSelectPinnedSchema: () => undefined,
        onGenerate: () => undefined,
        onCustomize: () => undefined,
        onNodesChange: () => undefined,
        annotationCount: 0,
        annotationsMode: 'hints',
        onAnnotationsModeChange: () => undefined,
      }),
    )

    expect(html).toContain('FieldReports / Burial_Finds')
    expect(html).toContain('JournalArticles / collagen_extraction')
    expect(html).toContain('pinned from FREE-technical')
    expect(html).not.toContain('+ Add field')
  })
})
