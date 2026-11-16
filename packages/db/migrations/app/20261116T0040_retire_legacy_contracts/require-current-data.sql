WITH methods(value) AS (
  SELECT "requestedSettings" FROM public.extraction
  UNION ALL SELECT "requestedSettings" FROM public."batchExtraction"
  UNION ALL SELECT method->'settings' FROM extraction_runtime.selection
), retired AS (
  SELECT 1 FROM methods WHERE value IS NULL OR jsonb_typeof(value) <> 'object'
    OR value ?| ARRAY['generic','recipe']
    OR (value ? 'article' AND (jsonb_typeof(value->'article') <> 'object'
      OR value->'article' ?| ARRAY['identity','identity_fields','prompt','selection','grounding_schedule','grounding_routing']))
    OR (value ? 'unified' AND (value->'unified'->'defaults' IS DISTINCT FROM '11'::jsonb OR value->'unified' ? 'verification'))
  UNION ALL SELECT 1 FROM public.extraction e WHERE e."requestedPages" IS NOT NULL
    OR NOT EXISTS (SELECT FROM extraction_runtime.head h WHERE h.id=e.id)
  UNION ALL SELECT 1 FROM public."modelConfiguration" WHERE
    (document->'extractionSettings' ? 'article' AND jsonb_typeof(document->'extractionSettings'->'article') <> 'object')
    OR document->'extractionSettings'->'article' ?| ARRAY['identity','identity_fields','prompt','selection','grounding_schedule','grounding_routing']
    OR document->'extractionSettings'->'catalog'->'unified' ? 'verification'
  UNION ALL SELECT 1 FROM public."schemaRevision" WHERE "modelAttribution" IS NOT NULL AND
    (jsonb_typeof("modelAttribution") <> 'object' OR NOT ("modelAttribution" ? 'sourceCoverage')
     OR "modelAttribution" - 'sourceCoverage' <> '{}'::jsonb)
  UNION ALL SELECT 1 FROM public."batchSchemaSuggestion" WHERE
    (coverage IS NOT NULL AND jsonb_typeof(coverage) <> 'array') OR
    EXISTS (SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coverage)='array' THEN coverage ELSE '[]'::jsonb END) c
      WHERE jsonb_typeof(c->'combined') IS DISTINCT FROM 'boolean' OR c->'sourceCoverage' IS NULL)
    OR (phase='READY' AND (draft IS NULL OR jsonb_typeof(draft) <> 'object'
      OR NOT (draft ? 'recordDescription' AND draft ? 'schemaNodes')))
  UNION ALL SELECT 1 FROM public."projectChatEntry" WHERE
    COALESCE(entry->>'kind','') NOT IN ('message','instruction','step','document')
  UNION ALL SELECT 1 FROM public."projectSpreadsheetVersion" WHERE rows IS NULL OR jsonb_typeof(rows) <> 'array'
    OR EXISTS (SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(columns)='array' THEN columns ELSE '[]'::jsonb END) c
      WHERE jsonb_typeof(c) <> 'object' OR c ? 'values')
)
SELECT NOT EXISTS (SELECT FROM retired) AS ok
