// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  createSchemaEditorController,
  localSchemaPersistence,
  type SchemaEditorController,
} from './currentSchemaRevision'
import { useSchemaEditorController } from './useCurrentSchemaRevision'

it('keeps the mount-scoped controller usable through StrictMode effect replay', async () => {
  let controller: SchemaEditorController | null = null
  function Probe() {
    controller = useSchemaEditorController(() =>
      createSchemaEditorController(
        localSchemaPersistence({ onEdit: () => undefined }),
        {
          initialDraft: {
            recordDescription: 'One record.',
            schemaNodes: [{ id: 'field-1', name: 'field', type: 'string' }],
          },
        },
      ),
    )
    return null
  }

  const mounted = render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  )
  const activeRequest = vi.fn(async () => ({
    _description: 'One generated record.',
    field: 'string',
  }))

  await act(async () => {
    await controller!.generate(activeRequest)
  })
  expect(activeRequest).toHaveBeenCalledOnce()

  mounted.unmount()
  await Promise.resolve()
  const disposedRequest = vi.fn(async () => ({
    _description: 'One later record.',
    field: 'string',
  }))
  await controller!.generate(disposedRequest)
  expect(disposedRequest).not.toHaveBeenCalled()
})
