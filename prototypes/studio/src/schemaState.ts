import type { ExtractionSchemaEnvelope } from './api'
import type { SchemaNode } from './schemaNode'

export type TemplateState =
  | { status: 'idle' }
  | { status: 'generating' }
  | {
      status: 'ready'
      schema: Omit<ExtractionSchemaEnvelope, 'record'>
      nodes: SchemaNode[]
      inputsKey: string
      source: 'generated' | 'pinned' | 'custom'
      pinnedSchemaId?: string
      basePinnedSchemaId?: string
      edited?: boolean
    }
  | { status: 'error'; message: string }

export function customizePinnedSchemaState(state: TemplateState): TemplateState {
  if (state.status !== 'ready' || state.source !== 'pinned') return state
  return {
    ...state,
    source: 'custom',
    basePinnedSchemaId: state.pinnedSchemaId,
    pinnedSchemaId: undefined,
    nodes: structuredClone(state.nodes),
  }
}

export function schemaMetadata(schema: ExtractionSchemaEnvelope): Omit<ExtractionSchemaEnvelope, 'record'> {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'record')) as Omit<ExtractionSchemaEnvelope, 'record'>
}
