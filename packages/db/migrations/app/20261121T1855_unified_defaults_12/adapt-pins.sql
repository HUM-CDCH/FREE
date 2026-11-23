-- Unified Catalog defaults 12 replaced 11: the independent reading of an inherited value answers with the value alone.
-- Studio and the worker read every stored method pin through the admitted contract, so the pins move with it: an
-- Extraction's and a batch's requested settings, each selection's method and resolved options, and each resolved
-- configuration with its content digest. Resume and Retry then reuse the selection under the admitted version.
-- What a run recorded about itself stays as it was: snapshots, plans, captures and a selection's digest still name
-- version 11, so a saved result keeps the method that produced it.
-- The applied migration hash covers the original comments in the emitted ops.json.
UPDATE public.extraction SET "requestedSettings" = jsonb_set("requestedSettings", '{unified,defaults}', '12')
  WHERE "requestedSettings" #> '{unified,defaults}' = '11'::jsonb;
UPDATE public."batchExtraction" SET "requestedSettings" = jsonb_set("requestedSettings", '{unified,defaults}', '12')
  WHERE "requestedSettings" #> '{unified,defaults}' = '11'::jsonb;
-- Selections and resolved configurations are immutable to the runtime roles; this one rewrite lifts the guards inside
-- the migration's transaction.
ALTER TABLE extraction_runtime.selection DISABLE TRIGGER selection_immutable;
UPDATE extraction_runtime.selection SET
    method = CASE WHEN method #> '{settings,unified,defaults}' = '11'::jsonb
      THEN jsonb_set(method, '{settings,unified,defaults}', '12') ELSE method END,
    resolved = CASE WHEN resolved #> '{options,unified,defaults}' = '11'::jsonb
      THEN jsonb_set(resolved, '{options,unified,defaults}', '12') ELSE resolved END
  WHERE method #> '{settings,unified,defaults}' = '11'::jsonb OR resolved #> '{options,unified,defaults}' = '11'::jsonb;
ALTER TABLE extraction_runtime.selection ENABLE TRIGGER selection_immutable;
ALTER TABLE extraction_runtime.effective DISABLE TRIGGER effective_immutable;
UPDATE extraction_runtime.effective SET
    configuration = jsonb_set(configuration, '{options,unified,defaults}', '12'),
    digest = extraction_runtime.content_hash(jsonb_set(configuration, '{options,unified,defaults}', '12'))
  WHERE configuration #> '{options,unified,defaults}' = '11'::jsonb;
ALTER TABLE extraction_runtime.effective ENABLE TRIGGER effective_immutable;
