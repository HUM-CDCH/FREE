// Type guard: true for plain objects (excludes null and arrays).
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Counts leaf fields in a schema value
export function countTemplateFields(value: unknown): number {
  if (Array.isArray(value)) {
    return countTemplateFields(value[0])
  }
  if (isRecord(value)) {
    return Object.entries(value).reduce<number>(
      (sum, [key, child]) =>
        key === '_description' ? sum : sum + countTemplateFields(child),
      0,
    )
  }
  return 1
}

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

export function stripDescriptions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDescriptions)
  if (isRecord(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (k === '_description') continue
      out[k] = stripDescriptions(val)
    }
    return out
  }
  return v
}

export function compileInstructions(template: unknown, prefix = ''): string {
  if (!isRecord(template)) return ''
  const lines: string[] = []
  for (const [key, value] of Object.entries(template)) {
    if (key === '_description') continue
    const path = prefix ? `${prefix}.${key}` : key
    const child = Array.isArray(value) ? value[0] : value
    if (isRecord(child)) {
      const desc = typeof child['_description'] === 'string' ? child['_description'] : null
      if (desc) lines.push(`- ${path}: ${desc}`)
      const nested = compileInstructions(child, path)
      if (nested) lines.push(nested)
    }
  }
  return lines.join('\n')
}
