import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, apiBaseIssue, isValidApiBase, modelConfigSchema, uuidSchema } from './modelConfig.contract'

describe('model configuration runtime contract', () => {
  it('keeps the exact provider kinds and canonical lowercase UUIDs', () => {
    expect(PROVIDER_KINDS).toEqual([
      'ollama',
      'openai',
      'anthropic',
      'google',
      'codex-cli',
      'claude-code',
      'openai-compatible',
    ])
    expect(uuidSchema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(true)
    expect(uuidSchema.safeParse('11111111-1111-4111-8111-11111111111A').success).toBe(false)
    expect(modelConfigSchema.safeParse({ connections: [], routes: { extraction: null, interaction: null }, version: 1 }).success).toBe(false)
  })

  it.each([
    [' https://host.example/v1', 'API base must not have surrounding whitespace.'],
    ['https://host.example/v1\n', 'API base must not have surrounding whitespace.'],
    ['https://host.exa\u0001mple/v1', 'API base must not contain control characters.'],
    ['https://host.example\\v1', 'API base must not contain backslashes.'],
    ['host.example/v1', 'API base must be an absolute HTTP or HTTPS URL.'],
    ['ftp://host.example/v1', 'API base must be an absolute HTTP or HTTPS URL.'],
    ['https://', 'API base must be an absolute HTTP or HTTPS URL.'],
    ['https://user@host.example/v1', 'API base must not contain embedded userinfo.'],
    ['https://@host.example/v1', 'API base must not contain embedded userinfo.'],
    ['https://host.example/v1?models=1', 'API base must not contain a query.'],
    ['https://host.example/v1#models', 'API base must not contain a fragment.'],
  ])('rejects unsafe API base %s', (value, issue) => {
    expect(apiBaseIssue(value)).toBe(issue)
    expect(isValidApiBase(value)).toBe(false)
  })

  it.each(['http://localhost:11434/api', 'https://host.example/v1', 'https://host.example/v1/'])(
    'preserves valid API base %s',
    (value) => {
      expect(apiBaseIssue(value)).toBeNull()
      expect(isValidApiBase(value)).toBe(true)
    },
  )

  it('rejects a null API base in the UI predicate', () => {
    expect(isValidApiBase(null)).toBe(false)
  })
})
