import { clearInspector, inspectorResponse } from './_llm_inspector.js'

export const GET = inspectorResponse
export const DELETE = clearInspector
export type { LlmTrace } from '../shared/llmInspector.contract.js'
