import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { createCanonicalPackageStore } from './artifact-store.js'

const sha256 = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

function canonicalPackage() {
  const pdf = strToU8('%PDF-1.7\nfixture')
  const markdown = strToU8('# Durable Source Document\n')
  const document = strToU8(
    JSON.stringify({
      schema_version: 'parsed_document.v2',
      document: { content_sha256: sha256(pdf) },
      preprocessing: { preprocess_id: 'fixture-preprocess' },
      arbitration: { primary_document_parser: 'docling_pdf' },
      parser_runs: [{ parser: 'docling_pdf', version: '2.0.0' }],
    }),
  )
  const entries = [
    ['source.pdf', pdf, 'application/pdf'],
    ['parsed_document.json', document, 'application/json'],
    ['artifacts/document.llm.md', markdown, 'text/markdown; charset=utf-8'],
  ] as const
  const manifest = strToU8(
    JSON.stringify({
      package_version: 'canonical-ingestion-package.v1',
      parsed_document_schema_version: 'parsed_document.v2',
      source_sha256: sha256(pdf),
      preprocess_id: 'fixture-preprocess',
      entries: entries.map(([path, bytes, mediaType]) => ({
        path,
        media_type: mediaType,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      })),
    }),
  )
  return zipSync(
    Object.fromEntries([
      ['manifest.json', manifest],
      ...entries.map(([path, bytes]) => [path, bytes]),
    ]),
    { level: 0 },
  )
}

describe('canonical package store', () => {
  it('reopens owned artifacts without the Parsing Service task cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-owned-artifacts-'))
    try {
      const firstCheckout = createCanonicalPackageStore(root)
      const stored = await firstCheckout.save(canonicalPackage())

      // A fresh store instance stands in for another checkout/process. It knows
      // only the durable descriptor, never the Parsing Service task identity.
      const secondCheckout = createCanonicalPackageStore(root)
      const source = await secondCheckout.read(stored, 'source')
      const document = JSON.parse(new TextDecoder().decode(source.bytes))

      assert.equal(document.schema_version, 'parsed_document.v2')
      assert.equal((await secondCheckout.read(stored, 'pdf')).bytes[0], 0x25)
      assert.equal(
        new TextDecoder().decode(
          (await secondCheckout.read(stored, 'markdown')).bytes,
        ),
        '# Durable Source Document\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
