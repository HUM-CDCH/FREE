-- Alternatives carry readings, never a verification verdict. Fail closed on missing JSON members.
CREATE FUNCTION extraction_runtime.valid_disagreement(node jsonb, value jsonb, disagreement jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog
AS $$
DECLARE entry jsonb; leaf jsonb; at_value jsonb; child_id jsonb; child jsonb;
  alternative jsonb; origin jsonb; source_range jsonb;
  seen_paths jsonb := '[]'::jsonb; previous_id text; alternative_id text;
BEGIN
  IF jsonb_typeof(disagreement) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(disagreement)=0 THEN RETURN false; END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(disagreement) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF NOT (entry ?& ARRAY['path','alternatives']) OR entry-ARRAY['path','alternatives']<>'{}'::jsonb
      OR jsonb_typeof(entry->'path') IS DISTINCT FROM 'array'
      OR jsonb_typeof(entry->'alternatives') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(seen_paths) p WHERE p=entry->'path') THEN RETURN false; END IF;
    seen_paths := seen_paths || jsonb_build_array(entry->'path');
    leaf := node; at_value := value;
    FOR child_id IN SELECT * FROM jsonb_array_elements(entry->'path') LOOP
      IF jsonb_typeof(child_id) IS DISTINCT FROM 'string' OR leaf->>'type' IS DISTINCT FROM 'object'
        OR jsonb_typeof(leaf->'children') IS DISTINCT FROM 'array'
        OR jsonb_typeof(at_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      SELECT n INTO child FROM jsonb_array_elements(leaf->'children') n WHERE n->'id'=child_id;
      IF child IS NULL THEN RETURN false; END IF;
      at_value := at_value->(child->>'name'); leaf := child;
    END LOOP;
    IF at_value IS DISTINCT FROM 'null'::jsonb OR jsonb_array_length(entry->'alternatives')<2 THEN RETURN false; END IF;
    previous_id := NULL;
    FOR alternative IN SELECT * FROM jsonb_array_elements(entry->'alternatives') LOOP
      IF jsonb_typeof(alternative) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF NOT (alternative ?& ARRAY['id','value','origins']) OR alternative-ARRAY['id','value','origins']<>'{}'::jsonb
        OR jsonb_typeof(alternative->'id') IS DISTINCT FROM 'string'
        OR alternative->'value' IS NOT DISTINCT FROM 'null'::jsonb
        OR NOT coalesce(extraction_runtime.valid_value(leaf,alternative->'value'),false)
        OR jsonb_typeof(alternative->'origins') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      alternative_id := alternative->>'id';
      IF alternative_id !~ '^[a-f0-9]{64}$' OR (previous_id IS NOT NULL AND alternative_id COLLATE "C" <= previous_id COLLATE "C")
        OR jsonb_array_length(alternative->'origins')=0 THEN RETURN false; END IF;
      previous_id := alternative_id;
      FOR origin IN SELECT * FROM jsonb_array_elements(alternative->'origins') LOOP
        IF jsonb_typeof(origin) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
        IF NOT (origin ?& ARRAY['selectionId','generation','primary','overlap'])
          OR origin-ARRAY['selectionId','generation','primary','overlap']<>'{}'::jsonb
          OR jsonb_typeof(origin->'selectionId') IS DISTINCT FROM 'string'
          OR NOT coalesce(origin->>'selectionId' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false)
          OR jsonb_typeof(origin->'generation') IS DISTINCT FROM 'string' OR origin->>'generation'=''
          OR jsonb_typeof(origin->'primary') IS DISTINCT FROM 'array'
          OR jsonb_typeof(origin->'overlap') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        FOR source_range IN SELECT * FROM jsonb_array_elements((origin->'primary')||(origin->'overlap')) LOOP
          IF jsonb_typeof(source_range) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
          IF NOT (source_range ?& ARRAY['segment','start','end']) OR source_range-ARRAY['segment','start','end']<>'{}'::jsonb
            OR jsonb_typeof(source_range->'segment') IS DISTINCT FROM 'string' OR source_range->>'segment'=''
            OR jsonb_typeof(source_range->'start') IS DISTINCT FROM 'number'
            OR jsonb_typeof(source_range->'end') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
          -- Match the reader's z.number().int(): integer offsets must survive JSON's number representation.
          IF (source_range->>'start')::numeric NOT BETWEEN 0 AND 9007199254740991
            OR (source_range->>'end')::numeric NOT BETWEEN 0 AND 9007199254740991
            OR trunc((source_range->>'start')::numeric)<>(source_range->>'start')::numeric
            OR trunc((source_range->>'end')::numeric)<>(source_range->>'end')::numeric THEN RETURN false; END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN coalesce(true,false);
END $$;
ALTER FUNCTION extraction_runtime.valid_disagreement(jsonb,jsonb,jsonb) OWNER TO free_extraction_runtime;
REVOKE ALL ON FUNCTION extraction_runtime.valid_disagreement(jsonb,jsonb,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION extraction_runtime.publish_snapshot(p_extraction uuid, p_attempt uuid, epoch integer,
  identity uuid, selection uuid, body jsonb, coverage jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; s extraction_runtime.snapshot; d text; previous_coverage jsonb; retained_value jsonb; node jsonb; selected extraction_runtime.selection;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  IF selection IS DISTINCT FROM h."selectionId" OR jsonb_typeof(body) IS DISTINCT FROM 'array' OR jsonb_typeof(coverage) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid result snapshot' USING ERRCODE = '22023';
  END IF;
  IF coverage ? 'finalizedAttempt' AND (
    jsonb_typeof(coverage->'finalizedAttempt') IS DISTINCT FROM 'object'
    OR (coverage->'finalizedAttempt')-ARRAY['attemptId','selectionId','generation','complete']<>'{}'::jsonb
    OR coverage->'finalizedAttempt'->>'attemptId' IS DISTINCT FROM p_attempt::text
    OR coverage->'finalizedAttempt'->>'selectionId' IS DISTINCT FROM selection::text
    OR coverage->'finalizedAttempt'->'generation' IS DISTINCT FROM to_jsonb(h.generation)
    OR jsonb_typeof(coverage->'finalizedAttempt'->'complete') IS DISTINCT FROM 'boolean'
    OR EXISTS (SELECT FROM extraction_runtime.capture WHERE "extractionId"=p_extraction AND "inFlight")
  ) THEN
    RAISE EXCEPTION 'invalid final publication proof' USING ERRCODE='22023';
  END IF;
  d := extraction_runtime.content_hash(jsonb_build_object('values', body, 'coverage', coverage));
  SELECT * INTO s FROM extraction_runtime.snapshot WHERE id = identity;
  IF FOUND THEN
    IF s."extractionId" <> p_extraction OR s."selectionId" <> selection OR s.coverage->>'publicationDigest' <> d THEN
      RAISE EXCEPTION 'snapshot publication conflict' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(s);
  END IF;
  IF EXISTS (SELECT FROM jsonb_array_elements(body) v WHERE jsonb_typeof(v) <> 'object'
    OR NOT (v ?& ARRAY['id','recordId','fieldId','selectionId','schemaRevisionId','node','modelValue','evidence','grounding','processing','lineage','path'])
    OR v->>'selectionId' IS DISTINCT FROM selection::text) THEN
    RAISE EXCEPTION 'invalid retained values' USING ERRCODE = '22023';
  END IF;
  SELECT picked.* INTO selected FROM extraction_runtime.selection picked WHERE picked.id=publish_snapshot.selection;
  FOR retained_value IN SELECT * FROM jsonb_array_elements(body) LOOP
    SELECT n INTO node FROM jsonb_array_elements(selected."schemaTree"->'schemaNodes') n WHERE n->>'id'=retained_value->>'fieldId';
    IF node IS NULL OR node IS DISTINCT FROM retained_value->'node' OR retained_value->>'schemaRevisionId' IS DISTINCT FROM selected."schemaRevisionId"::text
      OR NOT extraction_runtime.valid_value(node,retained_value->'modelValue')
      OR retained_value->>'grounding' IS NULL OR retained_value->>'grounding' NOT IN ('grounded','ungrounded','provisional')
      OR retained_value->>'processing' IS NULL OR retained_value->>'processing' NOT IN ('saved','absent','unprocessed','failed')
      OR jsonb_typeof(retained_value->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(retained_value->'recordId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(retained_value->'path') IS DISTINCT FROM 'array' OR jsonb_typeof(retained_value->'lineage') IS DISTINCT FROM 'array'
      OR jsonb_typeof(retained_value->'evidence') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'retained value does not fit producing schema' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(retained_value->'path') part WHERE jsonb_typeof(part) NOT IN ('string','number')
      OR (jsonb_typeof(part)='number' AND (part::text)::numeric<0))
      OR EXISTS (SELECT FROM jsonb_array_elements(retained_value->'lineage') part WHERE jsonb_typeof(part)<>'string')
      OR EXISTS (SELECT FROM jsonb_array_elements(retained_value->'evidence') evidence WHERE
        jsonb_typeof(evidence)<>'object' OR jsonb_typeof(evidence->'anchorId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(evidence->'occurrenceIds') IS DISTINCT FROM 'array'
        OR jsonb_typeof(evidence->'producer') IS DISTINCT FROM 'object'
        OR evidence-ARRAY['anchorId','occurrenceIds','producer']<>'{}'::jsonb) THEN
      RAISE EXCEPTION 'invalid retained identity or evidence' USING ERRCODE='22023';
    END IF;
    IF retained_value ? 'disagreement' AND (retained_value->>'processing' IS DISTINCT FROM 'saved'
      OR NOT extraction_runtime.valid_disagreement(node,retained_value->'modelValue',retained_value->'disagreement')) THEN
      RAISE EXCEPTION 'invalid value disagreement' USING ERRCODE = '22023';
    END IF;
    node := NULL;
  END LOOP;
  SELECT previous.coverage INTO previous_coverage FROM extraction_runtime.snapshot previous
    WHERE previous."extractionId"=p_extraction AND previous.version=h."snapshotVersion";
  SELECT coalesce(jsonb_agg(v ORDER BY v->>'id'),'[]'::jsonb) INTO body FROM (
    SELECT old_value AS v FROM extraction_runtime.snapshot previous,
      jsonb_array_elements(previous.values) old_value
      WHERE previous."extractionId"=p_extraction AND previous.version=h."snapshotVersion"
      AND NOT EXISTS (SELECT FROM jsonb_array_elements(body) fresh WHERE fresh->>'id'=old_value->>'id')
    UNION ALL SELECT fresh FROM jsonb_array_elements(body) fresh
  ) merged;
  coverage := coverage || jsonb_build_object('publicationDigest',d,'completedScopes',
    coalesce(previous_coverage->'completedScopes','{}'::jsonb)||coalesce(coverage->'completedScopes','{}'::jsonb),
    'historicalProposals',coalesce(previous_coverage->'historicalProposals','{}'::jsonb)||coalesce(coverage->'historicalProposals','{}'::jsonb),
    'completedDocumentFields',coalesce(previous_coverage->'completedDocumentFields','{}'::jsonb)||coalesce(coverage->'completedDocumentFields','{}'::jsonb));
  d := extraction_runtime.content_hash(jsonb_build_object('values',body,'coverage',coverage));
  h."snapshotVersion" := h."snapshotVersion" + 1;
  INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES (identity, p_extraction, h."snapshotVersion", selection, d, body, coverage) RETURNING * INTO s;
  UPDATE extraction_runtime.head SET "snapshotVersion" = h."snapshotVersion" WHERE id = p_extraction;
  RETURN to_jsonb(s);
END $$;
