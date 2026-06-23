export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function countTemplateFields(value: unknown): number {
  if (Array.isArray(value)) {
    return countTemplateFields(value[0])
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((sum, child) => sum + countTemplateFields(child), 0)
  }
  return 1
}

export const FIELD_TYPES = [
  'verbatim-string',
  'string',
  'date',
  'date-time',
  'time',
  'boolean',
  'number',
  'integer',
  'country',
  'currency',
  'email',
  'object',
  'array',
] as const

export function fieldTypeLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array'
  }
  if (isRecord(value)) {
    return 'object'
  }
  return String(value)
}

// Fields are addressed by their chain of record keys; array hops (the
// template's repeating groups live in the array's first element) are
// traversed implicitly so paths stay stable across list nesting.
export type TemplatePath = string[]

type FieldVisitor = (out: Record<string, unknown>, key: string, value: unknown) => void

function transformField(node: unknown, path: TemplatePath, visit: FieldVisitor): unknown {
  if (Array.isArray(node)) {
    return [transformField(node[0], path, visit), ...node.slice(1)]
  }
  if (!isRecord(node) || path.length === 0) {
    return node
  }
  const [head, ...rest] = path
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key !== head) {
      out[key] = value
    } else if (rest.length === 0) {
      visit(out, key, value)
    } else {
      out[key] = transformField(value, rest, visit)
    }
  }
  return out
}

export function removeTemplateField(template: unknown, path: TemplatePath): unknown {
  return transformField(template, path, () => {})
}

/** Rename a field and/or change its type, preserving its position. */
export function patchTemplateField(
  template: unknown,
  path: TemplatePath,
  name: string,
  type: string,
): unknown {
  return transformField(template, path, (out, _key, value) => {
    if (type === fieldTypeLabel(value)) {
      out[name] = value
    } else if (type === 'object') {
      out[name] = {}
    } else if (type === 'array') {
      out[name] = ['string']
    } else {
      out[name] = type
    }
  })
}

export function addTemplateField(template: unknown, name: string, type: string): unknown {
  if (!isRecord(template)) {
    return template
  }
  return { ...template, [name]: type }
}
