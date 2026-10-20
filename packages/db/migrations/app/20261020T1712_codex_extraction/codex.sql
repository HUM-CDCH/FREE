-- Add an explicit Codex transport and conservative budget policy; retain exact HTTP/native validation.
CREATE OR REPLACE FUNCTION extraction_runtime.valid_provider(provider jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(provider)='object'
    AND provider ?& ARRAY['key','model','adapter','adapterVersion','url','timeout','maxTokens']
    AND provider - ARRAY['key','model','adapter','adapterVersion','url','timeout','maxTokens','nativeInfo']='{}'::jsonb
    AND provider->>'key' ~ '^[a-zA-Z0-9_.:/-]{1,200}$'
    AND length(provider->>'model') BETWEEN 1 AND 300
    AND provider->>'adapter' IN ('instruct','nuextract','gliformer','codex-cli') AND provider->'adapterVersion'='1'::jsonb
    AND ((provider->>'adapter'='codex-cli' AND provider->>'url'='codex://local')
      OR (provider->>'adapter'<>'codex-cli' AND provider->>'url' ~ '^https?://[^@?#[:space:]]+$'))
    AND provider->>'timeout' ~ '^[0-9]+(\.[0-9]+)?$'
    AND provider->>'maxTokens' ~ '^[0-9]+$'
    AND jsonb_typeof(provider->'timeout')='number' AND jsonb_typeof(provider->'maxTokens')='number'
    AND ((provider->>'adapter'<>'gliformer' AND NOT provider ? 'nativeInfo') OR
      (provider->>'adapter'='gliformer' AND provider->'nativeInfo' ?& ARRAY['protocol','model','identity','max_input_tokens']
       AND (provider->'nativeInfo')-ARRAY['protocol','model','identity','max_input_tokens']='{}'::jsonb
       AND provider->'nativeInfo'->'protocol'='1'::jsonb AND provider->'nativeInfo'->'model'=provider->'model'
       AND jsonb_typeof(provider->'nativeInfo'->'identity')='object'
       AND provider->'nativeInfo'->>'max_input_tokens' ~ '^[1-9][0-9]*$')),false)
$$;

CREATE OR REPLACE FUNCTION extraction_runtime.finalize_input(p_extraction uuid, p_attempt uuid, epoch integer,
  p_capture uuid, request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; c extraction_runtime.capture; i extraction_runtime.input; d text;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  SELECT * INTO c FROM extraction_runtime.capture WHERE id = p_capture AND "extractionId" = p_extraction;
  IF NOT FOUND OR c."reservationAttemptId" <> p_attempt OR c."reservationEpoch" <> epoch THEN
    RAISE EXCEPTION 'capture is not reserved' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(request) <> 'object' OR NOT (request ?& ARRAY['provider', 'composer', 'tokenizer', 'budget', 'examples', 'omissions', 'body'])
    OR (request - ARRAY['provider', 'composer', 'tokenizer', 'budget', 'examples', 'omissions', 'body']) <> '{}'::jsonb
    OR NOT extraction_runtime.valid_provider(request->'provider') OR request->'composer' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(request->'tokenizer') IS DISTINCT FROM 'object'
    OR jsonb_typeof(request->'examples') IS DISTINCT FROM 'array' OR jsonb_typeof(request->'omissions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(request->'body') IS DISTINCT FROM 'object'
    OR NOT (request->'budget' ?& ARRAY['counted','context','reserve'])
    OR coalesce(request->'budget'->>'counted','') !~ '^[0-9]+$'
    OR coalesce(request->'budget'->>'context','') !~ '^[1-9][0-9]*$'
    OR coalesce(request->'budget'->>'reserve','') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid finalized input' USING ERRCODE = '22023';
  END IF;
  IF (request->'budget')-ARRAY['counted','context','reserve']<>'{}'::jsonb
    OR (request->'provider'->>'adapter'<>'codex-cli' AND request->'tokenizer'->>'input_counting'='upper_bound')
    OR EXISTS (SELECT FROM jsonb_array_elements(request->'examples') example WHERE NOT EXISTS
      (SELECT FROM jsonb_array_elements(c.candidates) revision WHERE revision->'candidate'=example)) THEN
    RAISE EXCEPTION 'invalid captured guidance or budget' USING ERRCODE='22023';
  END IF;
  IF request->'body'->>'kind'='native' THEN
    IF NOT (request->'body' ?& ARRAY['kind','record','text','schema','identity','counted','context'])
      OR (request->'body')-ARRAY['kind','record','text','schema','identity','counted','context']<>'{}'::jsonb
      OR request->'provider'->>'adapter' IS DISTINCT FROM 'gliformer'
      OR request->'body'->'identity' IS DISTINCT FROM request->'provider'->'nativeInfo'->'identity' THEN
      RAISE EXCEPTION 'invalid captured native request' USING ERRCODE='22023';
    END IF;
  ELSIF request->'provider'->>'adapter'='codex-cli' THEN
    IF NOT (request->'body' ?& ARRAY['stage','record','system','user','schema','max_tokens','max_whitespace','httpRequest'])
      OR (request->'body')-ARRAY['stage','record','system','user','schema','max_tokens','max_whitespace','httpRequest']<>'{}'::jsonb
      OR jsonb_typeof(request->'body'->'httpRequest') IS DISTINCT FROM 'object'
      OR request->'body'->>'stage' IS DISTINCT FROM c.descriptor->>'stage'
      OR jsonb_typeof(request->'body'->'system') IS DISTINCT FROM 'string'
      OR jsonb_typeof(request->'body'->'user') IS DISTINCT FROM 'string'
      OR (request->'body'->'httpRequest')-ARRAY['model','system','user','schema','max_tokens','policy']<>'{}'::jsonb
      OR request->'body'->'httpRequest'->'model' IS DISTINCT FROM request->'provider'->'model'
      OR request->'body'->'httpRequest'->'system' IS DISTINCT FROM request->'body'->'system'
      OR request->'body'->'httpRequest'->'user' IS DISTINCT FROM request->'body'->'user'
      OR request->'body'->'httpRequest'->'schema' IS DISTINCT FROM request->'body'->'schema'
      OR request->'body'->'httpRequest'->'max_tokens' IS DISTINCT FROM request->'budget'->'reserve'
      OR request->'body'->'max_tokens' IS DISTINCT FROM request->'budget'->'reserve'
      OR request->'body'->'max_whitespace' IS DISTINCT FROM 'null'::jsonb
      OR request->'body'->'httpRequest'->>'policy' IS DISTINCT FROM 'codex:utf8-budget-v1'
      OR request->'tokenizer'->>'source' IS DISTINCT FROM 'codex:utf8-budget-v1'
      OR request->'tokenizer'->>'model' IS DISTINCT FROM request->'provider'->>'model'
      OR request->'tokenizer'->>'input_counting' IS DISTINCT FROM 'upper_bound'
      OR (request->'budget'->>'context')::numeric > 65536
      OR (request->'budget'->>'counted')::numeric < 12288 THEN
      RAISE EXCEPTION 'invalid captured Codex request or budget policy' USING ERRCODE='22023';
    END IF;
  ELSE
    IF NOT (request->'body' ?& ARRAY['stage','record','system','user','schema','max_tokens','max_whitespace','httpRequest'])
      OR (request->'body')-ARRAY['stage','record','system','user','schema','max_tokens','max_whitespace','httpRequest']<>'{}'::jsonb
      OR jsonb_typeof(request->'body'->'httpRequest') IS DISTINCT FROM 'object'
      OR request->'body'->>'stage' IS DISTINCT FROM c.descriptor->>'stage'
      OR jsonb_typeof(request->'body'->'system') IS DISTINCT FROM 'string'
      OR jsonb_typeof(request->'body'->'user') IS DISTINCT FROM 'string'
      OR request->'body'->'httpRequest'->'model' IS DISTINCT FROM request->'provider'->'model'
      OR (request->'body'->'httpRequest')-ARRAY['model','temperature','max_tokens','messages','chat_template_kwargs','response_format','structured_outputs']<>'{}'::jsonb
      OR request->'body'->'httpRequest'->'max_tokens' IS DISTINCT FROM request->'budget'->'reserve'
      OR EXISTS (SELECT FROM jsonb_array_elements(request->'body'->'httpRequest'->'messages') message
        WHERE message-ARRAY['role','content']<>'{}'::jsonb OR message->>'role' NOT IN ('system','user')
          OR jsonb_typeof(message->'content') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'invalid captured chat request' USING ERRCODE='22023';
    END IF;
  END IF;
  IF (request->'budget'->>'counted')::numeric+(request->'budget'->>'reserve')::numeric > (request->'budget'->>'context')::numeric
    OR NOT EXISTS (SELECT FROM extraction_runtime.effective e WHERE e.id=h."selectionId"
      AND e.configuration->'models'->(c.descriptor->>'role')=request->'provider') THEN
    RAISE EXCEPTION 'unresolved provider or exceeded input budget' USING ERRCODE='22023';
  END IF;
  d := extraction_runtime.content_hash(request);
  SELECT * INTO i FROM extraction_runtime.input WHERE id = p_capture;
  IF FOUND THEN
    IF i.digest <> d THEN RAISE EXCEPTION 'immutable input conflict' USING ERRCODE = '23505'; END IF;
    RETURN to_jsonb(i);
  END IF;
  INSERT INTO extraction_runtime.input (id,digest,request) VALUES (p_capture, d, request) RETURNING * INTO i;
  RETURN to_jsonb(i);
END $$;

