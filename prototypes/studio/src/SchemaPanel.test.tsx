import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SchemaPanel from './SchemaPanel'
import { burialFindsPinnedSchema, pinnedSchemas } from './pinnedSchemas'

describe('SchemaPanel pinned schemas', () => {
  it('exposes Burial Finds as the selected read-only production schema', () => {
    const html = renderToStaticMarkup(
      createElement(SchemaPanel, {
        state: {
          status: 'ready',
			schema: burialFindsPinnedSchema.schema,
          inputsKey: '',
          source: 'pinned',
          pinnedSchemaId: 'FieldReports/Burial_Finds',
        },
        stale: false,
        pinnedSchemas,
        selectedPinnedSchemaId: 'FieldReports/Burial_Finds',
        onSelectPinnedSchema: () => undefined,
        onGenerate: () => undefined,
        onSchemaChange: () => undefined,
        onTemplateChange: () => undefined,
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
