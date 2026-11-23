-- 20261116T0040 removed the retired Article controls from requested settings and each selection's method, but a retained
-- Article Extraction still carried them where the worker reads its method: its selections' resolved options, which
-- Studio's canonical Article always wrote with identity, identity_fields and prompt, and its resolved configuration,
-- which the worker's Article serializer always wrote with the same keys. The worker validates both against the admitted
-- Article options, which refuse unknown keys, so Resume and Retry of such an Extraction failed before any work.
-- They go here too, and each rewritten configuration gets its content digest again, as 20261121T1855 does for
-- defaults 12. What a run recorded about itself stays as it was: a selection's digest, snapshots, plans and captures.
CREATE FUNCTION pg_temp.current_article(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value #> '{options,article}') = 'object'
    THEN jsonb_set(value, '{options,article}', (value #> '{options,article}')
      - ARRAY['identity','identity_fields','prompt','selection','grounding_schedule','grounding_routing'])
    ELSE value END $$;
-- Selections and resolved configurations are immutable to the runtime roles; this one rewrite lifts the guards inside
-- the migration's transaction.
ALTER TABLE extraction_runtime.selection DISABLE TRIGGER selection_immutable;
UPDATE extraction_runtime.selection SET resolved = pg_temp.current_article(resolved)
  WHERE pg_temp.current_article(resolved) IS DISTINCT FROM resolved;
ALTER TABLE extraction_runtime.selection ENABLE TRIGGER selection_immutable;
ALTER TABLE extraction_runtime.effective DISABLE TRIGGER effective_immutable;
UPDATE extraction_runtime.effective SET configuration = pg_temp.current_article(configuration),
    digest = extraction_runtime.content_hash(pg_temp.current_article(configuration))
  WHERE pg_temp.current_article(configuration) IS DISTINCT FROM configuration;
ALTER TABLE extraction_runtime.effective ENABLE TRIGGER effective_immutable;
