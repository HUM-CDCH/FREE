WITH pins(value) AS (
  SELECT "requestedSettings"->'unified' FROM public.extraction
  UNION ALL SELECT "requestedSettings"->'unified' FROM public."batchExtraction"
  UNION ALL SELECT method #> '{settings,unified}' FROM extraction_runtime.selection
  UNION ALL SELECT resolved #> '{options,unified}' FROM extraction_runtime.selection
  UNION ALL SELECT configuration #> '{options,unified}' FROM extraction_runtime.effective
)
SELECT NOT EXISTS (SELECT FROM pins WHERE jsonb_typeof(value) = 'object' AND value->'defaults' IS DISTINCT FROM '12'::jsonb)
  AND NOT EXISTS (SELECT FROM extraction_runtime.effective
    WHERE jsonb_typeof(configuration #> '{options,unified}') = 'object'
      AND digest IS DISTINCT FROM extraction_runtime.content_hash(configuration))
  AND NOT EXISTS (SELECT FROM pg_trigger
    WHERE tgrelid IN ('extraction_runtime.selection'::regclass, 'extraction_runtime.effective'::regclass)
      AND tgname IN ('selection_immutable', 'effective_immutable') AND tgenabled = 'D') AS ok
