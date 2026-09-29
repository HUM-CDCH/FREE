import type { ResultPath } from './types.js'

export function resultPathKey(path: ResultPath): string {
  return JSON.stringify(path)
}

export function valueAtPath(value: unknown, path: ResultPath): unknown {
  return path.reduce<unknown>((parent, key) => (parent as Record<string | number, unknown> | null | undefined)?.[key], value)
}

export function populatedContentPaths(value: unknown, path: ResultPath = []): ResultPath[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => populatedContentPaths(entry, [...path, index]))
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => populatedContentPaths(entry, [...path, key]))
  return value === '' || value === null || value === undefined ? [] : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [path] : []
}
