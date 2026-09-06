// Recover every typed value from an over-record-limit run for failed-run audit.
// This does not change the frozen extractor or turn the attempt into a success.
// node --experimental-strip-types scripts/diagnostic-output.mts --run DIR --source DIR
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { mapQuotes, mappedCanonicalSource, sha256, templateFromSchema, unwrapQuotes, validateCompletion, validateTyped, wrapTemplate, type MappedSource } from './quote-extraction.mts'

export function recoverDiagnostic(meta: any, transport: any, template: ReturnType<typeof templateFromSchema>, source: MappedSource) {
  if (meta.complete !== false || meta.error !== 'Error: Result exceeds 20 burial records') throw new Error('Only the exact over-record-limit failure can be recovered')
  if (meta.arm !== 'quote' && meta.arm !== 'baseline') throw new Error('Unknown extraction arm')
  if (!Number.isSafeInteger(meta.outputTokens) || meta.outputTokens < 1 || !Number.isSafeInteger(meta.context) || meta.context <= meta.outputTokens) throw new Error('Invalid original token budgets')
  validateCompletion(transport, meta.outputTokens)
  if (transport.prompt_eval_count + transport.eval_count > meta.context) throw new Error('Reported token usage exceeds context')
  const wrapped = JSON.parse(transport.message.content)
  validateTyped(wrapped, meta.arm === 'quote' ? wrapTemplate(template) : template)
  const recovered = meta.arm === 'quote' ? unwrapQuotes(wrapped, template) : { result: wrapped, quotes: [] }
  const recordCount = (recovered.result as { records: unknown[] }).records?.length
  if (!Number.isInteger(recordCount) || recordCount <= 20) throw new Error('Recovered result does not exceed the frozen record limit')
  return { result: recovered.result, mappings: mapQuotes(source, recovered.quotes), recordCount }
}

function main() {
  const args = process.argv.slice(2)
  const run = args[args.indexOf('--run') + 1], sourceDir = args[args.indexOf('--source') + 1]
  if (!args.includes('--run') || !args.includes('--source') || !run || !sourceDir) throw new Error('Required: --run DIR --source DIR')
  const names = ['diagnostic_extracted_raw.json', 'diagnostic_quote_mappings.json', 'diagnostic_meta.json']
  if (names.some((name) => existsSync(join(run, name)))) throw new Error('Diagnostic artifacts already exist; refusing to overwrite')
  const read = (name: string) => JSON.parse(readFileSync(join(run, name), 'utf8'))
  const meta = read('extracted_meta.json')
  const schemaBytes = readFileSync(join(sourceDir, 'schema.json'), 'utf8')
  const parsedBytes = readFileSync(join(sourceDir, 'parsed_document.json'))
  const source = mappedCanonicalSource(decodeParsedDocument(JSON.parse(parsedBytes.toString('utf8'))))
  const template = templateFromSchema(schemaBytes)
  const request = read('request.json')
  if (sha256(schemaBytes) !== meta.schemaSha256 || sha256(parsedBytes) !== meta.parsedSha256 || sha256(source.text) !== meta.sourceSha256
    || sha256(JSON.stringify(request)) !== meta.requestSha256 || JSON.stringify(template) !== JSON.stringify(read('template.json'))) throw new Error('Source, schema, request or template differs from the failed frozen attempt')
  const transportBytes = readFileSync(join(run, 'transport_raw.json'), 'utf8')
  const recovered = recoverDiagnostic(meta, JSON.parse(transportBytes), template, source)
  const resultText = JSON.stringify(recovered.result, null, 2) + '\n'
  const mappingsText = JSON.stringify(recovered.mappings, null, 2) + '\n'
  const diagnostic = { diagnosticOnly: true, usableForLabeling: true, originalAttemptComplete: false, originalError: meta.error,
    recoveredAt: new Date().toISOString(), recordCount: recovered.recordCount, recordLimit: 20,
    recoveryReason: 'All valid typed values from an over-record-limit failed attempt are retained for labeling; no records were sliced or accepted.',
    sourceSha256: meta.sourceSha256, parsedSha256: meta.parsedSha256, schemaSha256: meta.schemaSha256, requestSha256: meta.requestSha256,
    originalMetadataSha256: sha256(readFileSync(join(run, 'extracted_meta.json'))), transportSha256: sha256(transportBytes),
    diagnosticRawSha256: sha256(resultText), diagnosticQuoteMappingsSha256: sha256(mappingsText) }
  writeFileSync(join(run, names[0]), resultText, { flag: 'wx' })
  writeFileSync(join(run, names[1]), mappingsText, { flag: 'wx' })
  writeFileSync(join(run, names[2]), JSON.stringify(diagnostic, null, 2) + '\n', { flag: 'wx' })
  console.log(`Recovered ${recovered.recordCount} records for diagnostic labeling; original attempt remains failed.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
