CREATE OR REPLACE FUNCTION extraction_runtime.commit_output(p_extraction uuid, p_attempt uuid, epoch integer,
  p_capture uuid, input_digest text, output jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; c extraction_runtime.capture; o extraction_runtime.checkpoint; d text; recover boolean; recovery text; f extraction_runtime."callFailure";
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
    -- Only a first schema-constrained instruction-model record call gets one
    -- whitespace recovery. Its exact saved input becomes a bounded derived
    -- capture; an already bounded or prompt-only call cannot recover again.
    recovery := CASE WHEN c.descriptor->>'stage'='record' AND EXISTS (
      SELECT FROM extraction_runtime.input i WHERE i.id=p_capture
        AND i.request->'provider'->>'adapter'='instruct'
        AND i.request->'body'->>'stage'='record'
        AND i.request->'body'->'max_whitespace'='null'::jsonb
        AND i.request->'body'->'httpRequest'->'response_format'->>'type'='json_schema'
        AND NOT (i.request->'body'->'httpRequest' ? 'structured_outputs')
    ) AND NOT EXISTS (
      SELECT FROM jsonb_array_elements(output->'calls') call
      WHERE call->>'ok'='false' AND coalesce(call->>'recovered','false')<>'true'
        AND (call->>'finish' IS DISTINCT FROM 'length' OR call->>'stage' IS DISTINCT FROM 'record'
          OR coalesce(call->>'error','') NOT LIKE 'the reply ran into a whitespace loop%')
    ) THEN 'whitespace' END;
    -- The unified planner also has its existing bounded split fallback. A truncated
    -- discovery/entry reply remains attempt-local failure history, never a
    -- reusable checkpoint. Other errors still halt new admission.
    recover := recovery IS NOT NULL OR (EXISTS (SELECT FROM extraction_runtime.effective e WHERE e.id=c."selectionId"
      AND jsonb_typeof(e.configuration->'options'->'unified')='object') AND NOT EXISTS (
      SELECT FROM jsonb_array_elements(output->'calls') call
      WHERE call->>'ok'='false' AND coalesce(call->>'recovered','false')<>'true'
        AND (call->>'finish' IS DISTINCT FROM 'length'
             OR coalesce(call->>'stage','') NOT IN ('discovery','entry'))
    ));
    INSERT INTO extraction_runtime."callFailure" ("captureId","attemptId","inputDigest","outputDigest",output,recoverable,recovery)
      VALUES (p_capture,p_attempt,input_digest,d,output,recover,recovery) RETURNING * INTO f;
    UPDATE extraction_runtime.capture SET "inFlight"=false WHERE id=p_capture;
    IF NOT recover THEN
      UPDATE extraction_runtime.head SET intent=CASE WHEN intent='STOP' THEN 'STOP' ELSE 'PAUSE' END WHERE id=p_extraction;
    END IF;
    RETURN to_jsonb(f);
  END IF;
  INSERT INTO extraction_runtime.checkpoint (id,"inputDigest","outputDigest",output) VALUES (p_capture, input_digest, d, output) RETURNING * INTO o;
  UPDATE extraction_runtime.capture SET "inFlight" = false WHERE id = p_capture;
  RETURN to_jsonb(o);
END $$;


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
    SELECT * INTO parent FROM extraction_runtime.capture origin WHERE origin.id=(capture_unit.descriptor->>'derivedFrom')::uuid
      AND origin."extractionId"=p_extraction AND origin.generation=h.generation AND origin."selectionId"=h."selectionId"
      AND (EXISTS (SELECT FROM extraction_runtime.checkpoint o WHERE o.id=origin.id AND o.output->>'formatRefused'='true')
        OR EXISTS (SELECT FROM extraction_runtime."callFailure" f WHERE f."captureId"=origin.id
          AND f."attemptId"=p_attempt AND f.recoverable AND f.recovery='whitespace'));
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid fallback dependency' USING ERRCODE='22023'; END IF;
    v:=parent."feedbackVersion"; examples:=parent.candidates;
  END IF;
  INSERT INTO extraction_runtime.capture (id,"extractionId",generation,"unitKey","selectionId","originalAttemptId","feedbackVersion",candidates,descriptor,"reservationAttemptId","reservationEpoch","inFlight",invoked) VALUES (identity, p_extraction, h.generation, unit_key, h."selectionId",
    p_attempt, v, examples, descriptor, p_attempt, epoch, false, false) RETURNING * INTO c;
  RETURN to_jsonb(c) || jsonb_build_object('input', NULL, 'checkpoint', NULL);
END $$;

