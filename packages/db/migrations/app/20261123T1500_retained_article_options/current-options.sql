WITH options(value) AS (
  SELECT resolved #> '{options,article}' FROM extraction_runtime.selection
  UNION ALL SELECT configuration #> '{options,article}' FROM extraction_runtime.effective
)
SELECT NOT EXISTS (SELECT FROM options WHERE jsonb_typeof(value) = 'object'
    AND value ?| ARRAY['identity','identity_fields','prompt','selection','grounding_schedule','grounding_routing'])
  AND NOT EXISTS (SELECT FROM extraction_runtime.effective
    WHERE jsonb_typeof(configuration #> '{options,article}') = 'object'
      AND digest IS DISTINCT FROM extraction_runtime.content_hash(configuration))
  AND NOT EXISTS (SELECT FROM pg_trigger
    WHERE tgrelid IN ('extraction_runtime.selection'::regclass, 'extraction_runtime.effective'::regclass)
      AND tgname IN ('selection_immutable', 'effective_immutable') AND tgenabled = 'D') AS ok
