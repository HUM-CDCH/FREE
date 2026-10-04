-- Protocol 1 additive retry history; no public or DBOS table changes.
GRANT SELECT, INSERT ON extraction_runtime."callFailure" TO free_extraction_runtime;
CREATE TRIGGER "callFailure_immutable" BEFORE UPDATE ON extraction_runtime."callFailure" FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE OR REPLACE FUNCTION extraction_runtime.capture_unit(p_extraction uuid, p_attempt uuid, epoch integer,
  identity uuid, unit_key text, descriptor jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; c extraction_runtime.capture; project uuid; v integer; examples jsonb; parent extraction_runtime.capture;
BEGIN
  -- Lock order: project feedback before p_extraction control, including replays.
  SELECT "projectId" INTO project FROM extraction_runtime.head WHERE id = p_extraction;
  SELECT version INTO v FROM extraction_runtime."feedbackHead" WHERE id = project FOR SHARE;
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  SELECT * INTO c FROM extraction_runtime.capture WHERE "extractionId" = p_extraction
    AND generation = h.generation AND "unitKey" = unit_key;
  IF FOUND THEN
    IF c.descriptor IS DISTINCT FROM descriptor THEN RAISE EXCEPTION 'unit identity conflict' USING ERRCODE = '23505'; END IF;
    IF h.intent <> 'RUN' AND NOT EXISTS (SELECT FROM extraction_runtime.checkpoint WHERE id=c.id) AND NOT EXISTS (SELECT FROM extraction_runtime."callFailure" WHERE "captureId"=c.id AND "attemptId"=p_attempt) THEN RETURN NULL; END IF;
    UPDATE extraction_runtime.capture SET "reservationAttemptId" = p_attempt, "reservationEpoch" = epoch WHERE id = c.id;
    c."reservationAttemptId" := p_attempt; c."reservationEpoch" := epoch;
    RETURN to_jsonb(c) || jsonb_build_object('input', (SELECT to_jsonb(i) FROM extraction_runtime.input i WHERE i.id = c.id),
      'checkpoint', coalesce((SELECT to_jsonb(o) FROM extraction_runtime.checkpoint o WHERE o.id = c.id), (SELECT to_jsonb(f) FROM extraction_runtime."callFailure" f WHERE f."captureId"=c.id AND f."attemptId"=p_attempt)));
  END IF;
  IF h.intent <> 'RUN' THEN RETURN NULL; END IF;
  IF v IS NULL OR length(unit_key) NOT BETWEEN 1 AND 256 OR jsonb_typeof(descriptor) <> 'object'
     OR NOT (descriptor ?& ARRAY['stage', 'scope', 'ordinal', 'planDigest', 'role'])
     OR descriptor-ARRAY['stage','scope','ordinal','planDigest','role','derivedFrom']<>'{}'::jsonb
     OR descriptor->>'role' IS NULL OR descriptor->>'role' NOT IN ('fields', 'reasoning')
     OR coalesce(descriptor->>'ordinal','') !~ '^[0-9]+$' OR jsonb_typeof(descriptor->'scope') IS DISTINCT FROM 'string'
     OR NOT EXISTS (SELECT FROM extraction_runtime.plan p WHERE p."extractionId" = p_extraction
       AND p.generation = h.generation AND p.digest = descriptor->>'planDigest'
       AND p.manifest->'units' @> jsonb_build_array(jsonb_build_object('key', unit_key))) THEN
    RAISE EXCEPTION 'unit absent from immutable manifest' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(active) ORDER BY active."feedbackVersion" DESC, active.id), '[]'::jsonb) INTO examples FROM (
    SELECT DISTINCT ON (r."extractionId", r."valueId") r.* FROM extraction_runtime.correction r
    WHERE r."projectId" = project AND r."feedbackVersion" <= v
    ORDER BY r."extractionId", r."valueId", r.revision DESC
  ) active WHERE active.included;
  IF descriptor ? 'derivedFrom' THEN
    SELECT * INTO parent FROM extraction_runtime.capture origin WHERE origin.id=(descriptor->>'derivedFrom')::uuid
      AND origin."extractionId"=p_extraction AND origin.generation=h.generation AND origin."selectionId"=h."selectionId"
      AND EXISTS (SELECT FROM extraction_runtime.checkpoint o WHERE o.id=origin.id AND o.output->>'formatRefused'='true');
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid fallback dependency' USING ERRCODE='22023'; END IF;
    v:=parent."feedbackVersion"; examples:=parent.candidates;
  END IF;
  INSERT INTO extraction_runtime.capture (id,"extractionId",generation,"unitKey","selectionId","originalAttemptId","feedbackVersion",candidates,descriptor,"reservationAttemptId","reservationEpoch","inFlight",invoked) VALUES (identity, p_extraction, h.generation, unit_key, h."selectionId",
    p_attempt, v, examples, descriptor, p_attempt, epoch, false, false) RETURNING * INTO c;
  RETURN to_jsonb(c) || jsonb_build_object('input', NULL, 'checkpoint', NULL);
END $$;

CREATE OR REPLACE FUNCTION extraction_runtime.begin_call(p_extraction uuid, p_attempt uuid, epoch integer, p_capture uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; c extraction_runtime.capture;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  IF h.intent <> 'RUN' THEN RETURN false; END IF;
  SELECT * INTO c FROM extraction_runtime.capture WHERE id = p_capture AND "extractionId" = p_extraction;
  IF NOT FOUND OR c."reservationAttemptId" <> p_attempt OR c."reservationEpoch" <> epoch OR c."inFlight"
     OR NOT EXISTS (SELECT FROM extraction_runtime.input WHERE id = p_capture) THEN
    RAISE EXCEPTION 'call is not reserved or finalized' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT FROM extraction_runtime.checkpoint WHERE id = p_capture) OR EXISTS (SELECT FROM extraction_runtime."callFailure" WHERE "captureId"=p_capture AND "attemptId"=p_attempt) THEN RETURN false; END IF;
  UPDATE extraction_runtime.capture SET "inFlight" = true, invoked = true WHERE id = p_capture;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION extraction_runtime.commit_output(p_extraction uuid, p_attempt uuid, epoch integer,
  p_capture uuid, input_digest text, output jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; c extraction_runtime.capture; o extraction_runtime.checkpoint; d text; f extraction_runtime."callFailure";
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  SELECT * INTO c FROM extraction_runtime.capture WHERE id = p_capture AND "extractionId" = p_extraction;
  IF NOT FOUND OR c."reservationAttemptId" <> p_attempt OR c."reservationEpoch" <> epoch
     OR NOT EXISTS (SELECT FROM extraction_runtime.input i WHERE i.id = p_capture AND i.digest = input_digest) THEN
    RAISE EXCEPTION 'output authorization or digest mismatch' USING ERRCODE = '40001';
  END IF;
  d := extraction_runtime.content_hash(output);
  SELECT * INTO o FROM extraction_runtime.checkpoint WHERE id = p_capture;
  IF FOUND THEN
    IF o."inputDigest" <> input_digest OR o."outputDigest" <> d THEN
      RAISE EXCEPTION 'checkpoint conflict' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(o);
  END IF;
  SELECT * INTO f FROM extraction_runtime."callFailure" WHERE "captureId"=p_capture AND "attemptId"=p_attempt;
  IF FOUND THEN
    IF f."inputDigest"<>input_digest OR f."outputDigest"<>d THEN RAISE EXCEPTION 'failure response conflict' USING ERRCODE='23505'; END IF;
    RETURN to_jsonb(f);
  END IF;
  IF NOT c."inFlight" THEN RAISE EXCEPTION 'call was not started' USING ERRCODE = '40001'; END IF;
  -- PAUSE and STOP deliberately allow outputs admitted before their command.
  IF coalesce(output->>'formatRefused','false')<>'true' AND EXISTS (
    SELECT FROM jsonb_array_elements(output->'calls') call WHERE call->>'ok'='false' AND coalesce(call->>'recovered','false')<>'true'
  ) THEN
    INSERT INTO extraction_runtime."callFailure" ("captureId","attemptId","inputDigest","outputDigest",output)
      VALUES (p_capture,p_attempt,input_digest,d,output) RETURNING * INTO f;
    UPDATE extraction_runtime.capture SET "inFlight"=false WHERE id=p_capture;
    RETURN to_jsonb(f);
  END IF;
  INSERT INTO extraction_runtime.checkpoint (id,"inputDigest","outputDigest",output) VALUES (p_capture, input_digest, d, output) RETURNING * INTO o;
  UPDATE extraction_runtime.capture SET "inFlight" = false WHERE id = p_capture;
  RETURN to_jsonb(o);
END $$;

CREATE OR REPLACE FUNCTION extraction_runtime.read_call(p_extraction uuid, p_attempt uuid, epoch integer, identity uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; c extraction_runtime.capture;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  SELECT * INTO c FROM extraction_runtime.capture WHERE id = identity AND "extractionId" = p_extraction
    AND "selectionId" = h."selectionId" AND generation = h.generation;
  IF NOT FOUND THEN RAISE EXCEPTION 'capture is not in the current selection' USING ERRCODE = '40001'; END IF;
  IF c."inFlight" AND c."reservationEpoch" = epoch THEN
    RAISE EXCEPTION 'capture is already in flight' USING ERRCODE = '55P03';
  END IF;
  UPDATE extraction_runtime.capture SET "reservationAttemptId"=p_attempt,"reservationEpoch"=epoch WHERE id=identity;
  RETURN jsonb_build_object('capture',to_jsonb(c),'intent',h.intent,
    'input',(SELECT to_jsonb(i) FROM extraction_runtime.input i WHERE i.id=identity),
    'checkpoint',coalesce((SELECT to_jsonb(o) FROM extraction_runtime.checkpoint o WHERE o.id=identity), (SELECT to_jsonb(f) FROM extraction_runtime."callFailure" f WHERE f."captureId"=identity AND f."attemptId"=p_attempt)));
END $$;

CREATE FUNCTION extraction_runtime.read_attempt_outcome(p_extraction uuid,p_attempt uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
AS $$ SELECT outcome FROM extraction_runtime.attempt WHERE id=p_attempt AND "extractionId"=p_extraction $$;
ALTER FUNCTION extraction_runtime.read_attempt_outcome(uuid,uuid) OWNER TO free_extraction_runtime;
REVOKE ALL ON FUNCTION extraction_runtime.read_attempt_outcome(uuid,uuid) FROM PUBLIC;

-- Deletion fences worker writes in the SAME transaction as the public cascade.
-- The definer uses OLD.id and never reads public or either DBOS schema.
CREATE FUNCTION extraction_runtime.fence_deleted_extraction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$ BEGIN
  UPDATE extraction_runtime.head SET deleted=true,intent='STOP',"pendingResume"=false,"pendingSelectionId"=NULL WHERE id=OLD.id;
  RETURN OLD;
END $$;
ALTER FUNCTION extraction_runtime.fence_deleted_extraction() OWNER TO free_extraction_runtime;
REVOKE ALL ON FUNCTION extraction_runtime.fence_deleted_extraction() FROM PUBLIC;
CREATE TRIGGER durable_extraction_delete BEFORE DELETE ON public.extraction FOR EACH ROW EXECUTE FUNCTION extraction_runtime.fence_deleted_extraction();
CREATE TRIGGER artifactReference_immutable BEFORE UPDATE ON extraction_runtime."artifactReference" FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();

-- Carry source coverage and historical aggregation proposals across publications.
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
        OR evidence-ARRAY['anchorId','occurrenceIds']<>'{}'::jsonb) THEN
      RAISE EXCEPTION 'invalid retained identity or evidence' USING ERRCODE='22023';
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

-- Cleanup can inspect only a fenced deleted graph; no application or DBOS reads.
CREATE FUNCTION extraction_runtime.read_deleted_graph(p_extraction uuid,p_fence integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('attempts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'workflowId',a."workflowId")) FROM extraction_runtime.attempt a WHERE a."extractionId"=h.id),'[]'::jsonb),
    'captures',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id)) FROM extraction_runtime.capture c WHERE c."extractionId"=h.id),'[]'::jsonb))
  FROM extraction_runtime.head h WHERE h.id=p_extraction AND h.fence=p_fence AND h.deleted
    AND (h."leaseUntil" IS NULL OR h."leaseUntil"<clock_timestamp())
$$;
ALTER FUNCTION extraction_runtime.read_deleted_graph(uuid,integer) OWNER TO free_extraction_runtime;
REVOKE ALL ON FUNCTION extraction_runtime.read_deleted_graph(uuid,integer) FROM PUBLIC;
