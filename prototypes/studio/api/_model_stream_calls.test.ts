import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

/** Stream calls in `source` beyond the explicit `onError:` options it names: a coarse count, enough to stop a call
 *  that relies on the SDK's default onError, which logs provider bodies and `Bearer <key>` messages (Ruling 5). */
function unhandledStreamCalls(source: string): number {
  const calls = source.match(/\b(?:streamText|streamObject)\(/g)?.length ?? 0
  const handled = source.match(/\bonError:/g)?.length ?? 0
  return Math.max(0, calls - handled)
}

it('the scan counts a stream call without onError', () => {
  expect(unhandledStreamCalls('const r = streamText({ model })')).toBe(1)
  expect(unhandledStreamCalls('const r = streamObject({ model, onError: log })')).toBe(0)
})

it('every streamText and streamObject call in server code passes an explicit onError', () => {
  for (const directory of ['api', 'server']) {
    const root = join(import.meta.dirname, '..', directory)
    for (const file of readdirSync(root).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      expect({ file, unhandled: unhandledStreamCalls(readFileSync(join(root, file), 'utf8')) }).toEqual({ file, unhandled: 0 })
    }
  }
})
