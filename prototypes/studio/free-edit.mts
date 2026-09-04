import { generateSchemaEditJson } from './api/_model.ts'
void (async () => {
  try {
    const r = await generateSchemaEditJson('Add a width field of type number to the grave records. Return JSON only.')
    console.log('SCHEMA-EDIT SUCCESS', JSON.stringify(r).slice(0, 300))
  } catch (e) {
    console.log('SCHEMA-EDIT FAILED')
    console.log(e?.constructor?.name, JSON.stringify(e?.message))
    console.log('cause:', e?.cause?.constructor?.name, e?.cause?.message)
    console.log('causeData:', JSON.stringify(e?.cause?.data ?? e?.cause?.cause ?? {}, null, 2)?.slice(0, 1200))
  }
  process.exit(0)
})()
