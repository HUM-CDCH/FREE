/** Mirrors the worker's lossless JSONB text codec; only versioned paths are decoded. */
const MARKER = '_freeJsonbStrings'
const VERSION = 1
const CONTAINERS = new Set(['input', 'checkpoint', 'snapshot', 'selection', 'effective', 'capture', 'candidates',
  'request', 'output', 'values', 'coverage', 'manifest', 'configuration', 'candidate', 'decision',
  'captures', 'failedCalls', 'snapshots', 'corrections', 'plans', 'selections', 'attempts', 'finalizations'])
type Path = (string | number)[]
type Encoding = { version: number; strings: Path[]; keys: Path[] }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
const requestKeys = ['provider', 'composer', 'tokenizer', 'budget', 'examples', 'omissions', 'body']
const request = (value: Record<string, unknown>) =>
  Object.keys(value).length === requestKeys.length && requestKeys.every(key => key in value)

function escapeText(value: unknown): { stored: unknown; encoding: Encoding | null } {
  const encoding: Encoding = { version: VERSION, strings: [], keys: [] }
  function visit(item: unknown, path: Path): unknown {
    if (typeof item === 'string' && item.includes('\0')) {
      encoding.strings.push(path)
      return JSON.stringify(item)
    }
    if (Array.isArray(item)) return item.map((part, index) => visit(part, [...path, index]))
    if (object(item)) {
      const escapeKeys = Object.keys(item).some(key => key.includes('\0'))
      if (escapeKeys) encoding.keys.push(path)
      return Object.fromEntries(Object.entries(item).map(([key, part]) => {
        const stored = escapeKeys ? JSON.stringify(key) : key
        return [stored, visit(part, [...path, stored])]
      }))
    }
    return item
  }
  const stored = visit(value, [])
  return { stored, encoding: encoding.strings.length || encoding.keys.length ? encoding : null }
}

function restoreText(value: unknown, encoding: Encoding): unknown {
  if (!encoding || encoding.version !== VERSION || !Array.isArray(encoding.strings) || !Array.isArray(encoding.keys))
    throw new Error('Unsupported history text encoding')
  const restored = structuredClone(value)
  const at = (path: Path): Record<string | number, unknown> => {
    if (!Array.isArray(path)) throw new Error('Invalid encoded text path')
    let part = restored
    for (const key of path) {
      if ((typeof key !== 'string' && typeof key !== 'number') || part === null || typeof part !== 'object' || !Object.hasOwn(part, key))
        throw new Error('Invalid encoded text path')
      part = (part as Record<string | number, unknown>)[key]
    }
    if (part === null || typeof part !== 'object') throw new Error('Invalid encoded text container')
    return part as Record<string | number, unknown>
  }
  for (const path of encoding.strings) {
    if (!Array.isArray(path) || !path.length) throw new Error('Invalid encoded text path')
    const parent = at(path.slice(0, -1)), key = path.at(-1)!
    if (!Object.hasOwn(parent, key) || typeof parent[key] !== 'string') throw new Error('Invalid encoded JSONB string')
    const decoded: unknown = JSON.parse(parent[key] as string)
    if (typeof decoded !== 'string') throw new Error('Invalid encoded JSONB string')
    parent[key] = decoded
  }
  for (const path of [...encoding.keys].reverse()) {
    const part = at(path), decoded = Object.fromEntries(Object.entries(part).map(([key, item]) => {
      const original: unknown = JSON.parse(key)
      if (typeof original !== 'string') throw new Error('Invalid encoded JSONB key')
      return [original, item]
    }))
    for (const key of Object.keys(part)) delete part[key]
    // Keep arbitrary source keys, including __proto__, as own data properties.
    for (const [key, item] of Object.entries(decoded)) Object.defineProperty(part, key, { value: item, enumerable: true, writable: true, configurable: true })
  }
  return restored
}

export function encodeStorage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encodeStorage)
  if (!object(value)) return value
  if (request(value) && object(value.tokenizer)) {
    const { stored: body, encoding } = escapeText(value.body), tokenizer = { ...value.tokenizer }
    if (encoding) {
      if (MARKER in tokenizer) throw new Error('Reserved request storage metadata')
      tokenizer[MARKER] = encoding
    }
    return { ...value, body, tokenizer, examples: encodeStorage(value.examples) }
  }
  const { stored, encoding } = escapeText(value)
  if (encoding) {
    if (MARKER in value) throw new Error('Reserved history storage metadata')
    return { ...(stored as Record<string, unknown>), [MARKER]: encoding }
  }
  return stored
}

export function decodeStorage<T>(value: T): T {
  if (Array.isArray(value)) return value.map(decodeStorage) as T
  if (!object(value)) return value
  if (request(value) && object(value.tokenizer) && MARKER in value.tokenizer) {
    const { [MARKER]: encoding, ...tokenizer } = value.tokenizer
    return { ...value, tokenizer, body: restoreText(value.body, encoding as Encoding), examples: decodeStorage(value.examples) } as T
  }
  if (MARKER in value) {
    const { [MARKER]: encoding, ...stored } = value
    return restoreText(stored, encoding as Encoding) as T
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, CONTAINERS.has(key) ? decodeStorage(item) : item])) as T
}
