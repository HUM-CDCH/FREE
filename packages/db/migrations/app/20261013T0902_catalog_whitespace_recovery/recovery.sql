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
    -- Only a first schema-constrained instruction-model record or unified entry call gets one
    -- whitespace recovery. Its exact saved input becomes a bounded derived
    -- capture; an already bounded or prompt-only call cannot recover again.
    recovery := CASE WHEN (c.descriptor->>'stage'='record' OR (c.descriptor->>'stage'='entry' AND EXISTS (
      SELECT FROM extraction_runtime.effective e WHERE e.id=c."selectionId"
        AND jsonb_typeof(e.configuration->'options'->'unified')='object'
    ))) AND EXISTS (
      SELECT FROM extraction_runtime.input i WHERE i.id=p_capture
        AND i.request->'provider'->>'adapter'='instruct'
        AND i.request->'body'->>'stage'=c.descriptor->>'stage'
        AND i.request->'body'->'max_whitespace'='null'::jsonb
        AND i.request->'body'->'httpRequest'->'response_format'->>'type'='json_schema'
        AND NOT (i.request->'body'->'httpRequest' ? 'structured_outputs')
    ) AND NOT EXISTS (
      SELECT FROM jsonb_array_elements(output->'calls') call
      WHERE call->>'ok'='false' AND coalesce(call->>'recovered','false')<>'true'
        AND (call->>'finish' IS DISTINCT FROM 'length' OR call->>'stage' IS DISTINCT FROM c.descriptor->>'stage'
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

