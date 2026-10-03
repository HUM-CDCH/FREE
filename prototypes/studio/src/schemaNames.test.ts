import { describe, expect, it } from 'vitest'
import { defaultSchemaName } from './schemaNames'

describe('defaultSchemaName', () => {
  it('is the Source Document name without its extension', () => {
    expect(defaultSchemaName('Beretning_Ellekilde_8_13.pdf')).toBe('Beretning_Ellekilde_8_13')
    expect(defaultSchemaName('archive.tar.gz')).toBe('archive.tar')
    expect(defaultSchemaName('No extension')).toBe('No extension')
  })
  it('falls back to "Untitled schema" when the name would be empty or invalid', () => {
    expect(defaultSchemaName('.pdf')).toBe('Untitled schema')
    expect(defaultSchemaName('   ')).toBe('Untitled schema')
  })
})
