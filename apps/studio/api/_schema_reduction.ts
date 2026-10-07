import { ApiError } from './_http.js'
import { EXCERPT_THRESHOLD } from './_schema.js'

const block = (label: string, schema: unknown) => `${label} SCHEMA:\n${JSON.stringify(schema)}`

function tooLarge(): never {
  throw new ApiError(422, 'merge_input_too_large',
    `The suggestions cannot be combined within the ${EXCERPT_THRESHOLD.toLocaleString('en-US')}-character limit of one request.`)
}

/**
 * Fold labelled schemas into one, level by level: each level packs consecutive schemas into requests of at most
 * `budget` characters and `merge`s every group of two or more, in order and one at a time (a lone schema carries
 * forward). `step` names the request uniquely (`reduce:<level>:<group>`) so a caller can checkpoint it. No schema is
 * ever dropped or cut: one that cannot fit a request, or a level where no two fit together, fails.
 */
export async function reduceSchemas<T>(
  items: readonly { label: string; schema: T }[],
  merge: (text: string, step: string, group: readonly T[]) => Promise<T>,
  budget = EXCERPT_THRESHOLD,
): Promise<T> {
  let level = items.map(({ label, schema }) => ({ schema, text: block(label, schema) }))
  for (let depth = 1; level.length > 1; depth += 1) {
    const groups: (typeof level)[] = []
    let length = 0
    for (const item of level) {
      if (item.text.length > budget) tooLarge()
      const group = groups.at(-1)
      if (group && length + 2 + item.text.length <= budget) {
        group.push(item)
        length += 2 + item.text.length
      } else {
        groups.push([item])
        length = item.text.length
      }
    }
    if (groups.length === level.length) tooLarge()
    const next: typeof level = []
    for (const [index, group] of groups.entries()) {
      if (group.length === 1) {
        next.push(group[0]!)
        continue
      }
      const schema = await merge(
        group.map(({ text }) => text).join('\n\n'), `reduce:${depth}:${index + 1}`, group.map((item) => item.schema))
      next.push({ schema, text: block(`COMBINED ${depth}.${index + 1}`, schema) })
    }
    level = next
  }
  return level[0]!.schema
}
