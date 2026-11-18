import { isRecord, type SchemaNode } from './schema.js'
import type { DurableValue, ResultPath } from './durable-contract.js'

/** Original populated scalar cells, using the immutable producing value's paths. */
export function tableCellReview(value: Pick<DurableValue, 'node' | 'modelValue' | 'path' | 'processing' | 'disagreement'>) {
  const paths: ResultPath[] = []
  let otherParts = 0
  const visit = (node: SchemaNode, model: unknown, path: ResultPath, cell = false) => {
    if (model === null || model === undefined || model === '') return
    if (node.type === 'object' && isRecord(model)) {
      for (const child of node.children) {
        const modelField = Object.hasOwn(model, child.name) ? model[child.name] : undefined
        visit(child, modelField, [...path, child.name])
      }
      return
    }
    if (node.type === 'array' && Array.isArray(model)) {
      const columns = node.children
      if (!columns) {
        if (model.some(item => item !== null && item !== undefined && item !== '')) otherParts++
        return
      }
      model.forEach((row, index) => {
        if (!isRecord(row)) return
        for (const column of columns) {
          const modelCell = Object.hasOwn(row, column.name) ? row[column.name] : undefined
          visit(column, modelCell, [...path, index, column.name], true)
        }
      })
      return
    }
    if (cell && node.type !== 'object' && node.type !== 'array'
      && (typeof model === 'string' || typeof model === 'boolean' || typeof model === 'number')) paths.push(path)
    else otherParts++
  }
  if (value.processing === 'saved') visit(value.node, value.modelValue, value.path)
  return { paths, wholeValue: paths.length > 0 && otherParts === 0 && !value.disagreement }
}
