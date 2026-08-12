#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

function usage() {
  console.log(`Usage:
  node scripts/run-real-extraction-routing-diagnostic.mjs \\
    [--parsed-document ../parsing_service/data/documents/<sha>/parsed_document.json] \\
    [--out-dir ../parsing_service/data/diagnostics/real-extraction-routing]

This calls the real extraction model with an embedded Catalog table schema,
writes schema.json, extraction-response.json, and highlight-routing-report.json,
then prints a short routing summary.
`)
}

function parseArgs(argv) {
  const env = { ...process.env, RUN_REAL_EXTRACTION_ROUTING_DIAGNOSTIC: '1' }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      return { help: true, env }
    }
    if (arg === '--parsed-document') {
      env.REAL_PARSED_DOCUMENT = argv[++i]
      continue
    }
    if (arg === '--out-dir') {
      env.REAL_ROUTING_OUT_DIR = argv[++i]
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return { help: false, env }
}

try {
  const { help, env } = parseArgs(process.argv)
  if (help) {
    usage()
    process.exit(0)
  }
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', 'scripts/run-real-extraction-routing-diagnostic.test.ts'],
    { stdio: 'inherit', env },
  )
  process.exit(result.status ?? 1)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  usage()
  process.exit(2)
}
