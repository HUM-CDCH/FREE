import { expect, it } from 'vitest'
import { sparkRefusal } from './vite.spark.config.js'

const host = '127.0.0.1:5173'
const own = { 'sec-fetch-site': 'same-origin', origin: `http://${host}`, host }

it('forwards reads from this client, and writes only when allowed', () => {
  expect(sparkRefusal({ method: 'GET', headers: own }, false)).toBeNull()
  expect(sparkRefusal({ method: 'GET', headers: { host } }, false)).toBeNull()
  expect(sparkRefusal({ method: 'POST', headers: own }, false)?.code).toBe('read_only')
  expect(sparkRefusal({ method: 'POST', headers: own }, true)).toBeNull()
})

it('refuses other sites, even for reads and with writes allowed', () => {
  expect(sparkRefusal({ method: 'GET', headers: { ...own, 'sec-fetch-site': 'cross-site' } }, true)?.code).toBe('origin_rejected')
  expect(sparkRefusal({ method: 'POST', headers: { host, origin: 'https://example.org' } }, true)?.code).toBe('origin_rejected')
  expect(sparkRefusal({ method: 'DELETE', headers: { host } }, true)?.code).toBe('origin_rejected')
})
