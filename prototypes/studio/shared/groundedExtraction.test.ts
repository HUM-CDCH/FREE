import { describe, expect, it } from 'vitest'
import {
  evidenceLinksHaveUniqueScalarPaths,
  resultPathSchema,
  resultValueAtPath,
} from './groundedExtraction'

const result = {
  records: [
    {
      find_number: '24-1',
      published: true,
      count: 2,
      absent: null,
      empty: ' ',
      nested: { description: 'Lerkar' },
    },
  ],
}

describe('grounded Extraction paths', () => {
  it('resolves exact object keys and numeric array indices', () => {
    expect(resultValueAtPath(result, ['records', 0, 'find_number'])).toBe('24-1')
    expect(resultValueAtPath(result, ['records', '0', 'find_number'])).toBeUndefined()
    expect(resultValueAtPath(result, ['records', 1, 'find_number'])).toBeUndefined()
    expect(resultValueAtPath(result, ['missing'])).toBeUndefined()
  })

  it('accepts unique populated scalar paths', () => {
    expect(
      evidenceLinksHaveUniqueScalarPaths(result, [
        { resultPath: ['records', 0, 'find_number'], evidenceAnchorId: 'a1' },
        { resultPath: ['records', 0, 'published'], evidenceAnchorId: 'a1' },
        { resultPath: ['records', 0, 'count'], evidenceAnchorId: 'a2' },
      ]),
    ).toBe(true)
  })

  it.each([
    ['an absent path', ['records', 1, 'find_number']],
    ['a non-scalar object', ['records', 0, 'nested']],
    ['null', ['records', 0, 'absent']],
    ['an empty string', ['records', 0, 'empty']],
  ])('rejects %s', (_case, resultPath) => {
    expect(
      evidenceLinksHaveUniqueScalarPaths(result, [
        { resultPath, evidenceAnchorId: 'a1' },
      ]),
    ).toBe(false)
  })

  it('rejects duplicate paths even when their anchors differ', () => {
    const resultPath = ['records', 0, 'find_number'] as const
    expect(
      evidenceLinksHaveUniqueScalarPaths(result, [
        { resultPath, evidenceAnchorId: 'a1' },
        { resultPath, evidenceAnchorId: 'a2' },
      ]),
    ).toBe(false)
  })

  it('requires non-empty paths and nonnegative integer indices', () => {
    expect(resultPathSchema.safeParse([]).success).toBe(false)
    expect(resultPathSchema.safeParse(['records', -1]).success).toBe(false)
    expect(resultPathSchema.safeParse(['records', 0.5]).success).toBe(false)
  })
})
