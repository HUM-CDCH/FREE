-- Brings historical rows into the shape require-current-data.sql accepts, before the schema changes that follow.
-- Article pins only carry controls the UI no longer offers: those keys are dropped and the runs stay. Their
-- selection's `resolved` options and digest keep what was admitted: such a run is shown and retried (Retry resolves a
-- new selection from the settings), never resumed under the old options.
-- Every other retired pin (generic/recipe, unified defaults other than 11 or a verification key, missing or
-- non-object settings, a sample's requestedPages, a pre-durable row without a runtime head) has no current
-- equivalent: its Extraction, runtime rows, corrections and batch are deleted.
CREATE FUNCTION pg_temp.stripped(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'object' AND jsonb_typeof(value->'article') = 'object'
    THEN jsonb_set(value, '{article}', (value->'article')
      - ARRAY['identity','identity_fields','prompt','selection','grounding_schedule','grounding_routing'])
    ELSE value END $$;
-- The method part of require-current-data.sql, after stripping.
CREATE FUNCTION pg_temp.retired(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR jsonb_typeof(value) <> 'object'
    OR value ?| ARRAY['generic','recipe']
    OR (value ? 'article' AND (jsonb_typeof(value->'article') <> 'object'
      OR value->'article' ?| ARRAY['identity','identity_fields','prompt','selection','grounding_schedule','grounding_routing']))
    OR (value ? 'unified' AND (value->'unified'->'defaults' IS DISTINCT FROM '11'::jsonb OR value->'unified' ? 'verification')) $$;

UPDATE public.extraction SET "requestedSettings" = pg_temp.stripped("requestedSettings")
  WHERE pg_temp.stripped("requestedSettings") IS DISTINCT FROM "requestedSettings";
UPDATE public."batchExtraction" SET "requestedSettings" = pg_temp.stripped("requestedSettings")
  WHERE pg_temp.stripped("requestedSettings") IS DISTINCT FROM "requestedSettings";
-- Selections are immutable to the runtime roles; this one rewrite lifts the guard inside the migration's transaction.
ALTER TABLE extraction_runtime.selection DISABLE TRIGGER selection_immutable;
UPDATE extraction_runtime.selection SET method = jsonb_set(method, '{settings}', pg_temp.stripped(method->'settings'))
  WHERE jsonb_typeof(method) = 'object' AND pg_temp.stripped(method->'settings') IS DISTINCT FROM method->'settings';
ALTER TABLE extraction_runtime.selection ENABLE TRIGGER selection_immutable;

CREATE TEMP TABLE retired_extraction ON COMMIT DROP AS
  SELECT e.id FROM public.extraction e
  WHERE pg_temp.retired(e."requestedSettings") OR e."requestedPages" IS NOT NULL
    OR NOT EXISTS (SELECT FROM extraction_runtime.head h WHERE h.id = e.id)
    OR EXISTS (SELECT FROM public."batchExtraction" b WHERE b.id = e."batchExtractionId" AND pg_temp.retired(b."requestedSettings"))
  UNION SELECT s."extractionId" FROM extraction_runtime.selection s WHERE pg_temp.retired(s.method->'settings');
-- Corrections name their Extraction without a foreign key; the head cascades every other runtime row.
DELETE FROM extraction_runtime.correction WHERE "extractionId" IN (SELECT id FROM retired_extraction);
DELETE FROM extraction_runtime.head WHERE id IN (SELECT id FROM retired_extraction);
DELETE FROM public.extraction WHERE id IN (SELECT id FROM retired_extraction);
DELETE FROM public."batchExtraction" WHERE pg_temp.retired("requestedSettings");

-- Account preferences, as 20261116T0847 does for generic/recipe: retired Article keys and the Pro verification switch go.
UPDATE public."modelConfiguration" SET document = jsonb_set(document, '{extractionSettings}',
    CASE WHEN jsonb_typeof(document #> '{extractionSettings,article}') = 'object'
      THEN pg_temp.stripped(document->'extractionSettings') ELSE (document->'extractionSettings') - 'article' END
    #- '{catalog,unified,verification}')
  WHERE jsonb_typeof(document->'extractionSettings') = 'object' AND (
    (document->'extractionSettings' ? 'article' AND jsonb_typeof(document #> '{extractionSettings,article}') <> 'object')
    OR document #> '{extractionSettings,article}' ?| ARRAY['identity','identity_fields','prompt','selection','grounding_schedule','grounding_routing']
    OR document #> '{extractionSettings,catalog,unified}' ? 'verification');
