import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SHARED_STUDIO_CONFIGURATION_FIELDS,
  validateSharedStudioConfiguration,
} from './index.mjs'

const VALID = {
  STUDIO_ORIGIN: 'https://studio.example',
  STUDIO_BASE_PATH: '/',
  FREE_SESSION_SECRET: Buffer.alloc(32, 11).toString('base64'),
  FREE_ENTRA_TENANT_ID: '10000000-0000-4000-8000-000000000001',
  FREE_ENTRA_CLIENT_ID: '10000000-0000-4000-8000-000000000002',
  FREE_ENTRA_CLIENT_CERT_THUMBPRINT: 'ab:'.repeat(31) + 'ab',
  FREE_ENTRA_CLIENT_CERT_PATH: '/run/secrets/free-entra-client.pem',
}

describe('shared Studio configuration syntax', () => {
  it('reports every missing field without side effects', () => {
    const result = validateSharedStudioConfiguration({})
    assert.deepEqual(
      result.issues.map(({ field, code }) => ({ field, code })),
      SHARED_STUDIO_CONFIGURATION_FIELDS.map((field) => ({
        field,
        code: 'required',
      })),
    )
  })

  it('returns normalized values for both consumers', () => {
    const result = validateSharedStudioConfiguration({
      ...VALID,
      FREE_ENTRA_TENANT_ID: VALID.FREE_ENTRA_TENANT_ID.toUpperCase(),
    })

    assert.deepEqual(result.issues, [])
    assert.equal(
      result.values.FREE_ENTRA_TENANT_ID,
      VALID.FREE_ENTRA_TENANT_ID,
    )
    assert.equal(
      result.values.FREE_ENTRA_CLIENT_CERT_THUMBPRINT,
      'AB'.repeat(32),
    )
    assert.deepEqual(
      result.values.FREE_SESSION_SECRET,
      new Uint8Array(32).fill(11),
    )
  })
})
