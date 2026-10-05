-- Owned by a NOLOGIN role with no privileges on Studio's public/dbos schemas.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'free_extraction_runtime') THEN
    CREATE ROLE free_extraction_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  -- Independent disposable databases can bootstrap this cluster role together.
  NULL;
END $bootstrap$;
REVOKE ALL ON SCHEMA extraction_runtime FROM PUBLIC;
GRANT USAGE ON SCHEMA extraction_runtime TO free_extraction_runtime;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA extraction_runtime TO free_extraction_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE free_extraction_runtime IN SCHEMA extraction_runtime REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
INSERT INTO extraction_runtime.protocol (id,version) VALUES (1, 1);

ALTER TABLE extraction_runtime.head ADD CONSTRAINT head_intent CHECK (intent IN ('RUN', 'PAUSE', 'STOP'));
ALTER TABLE extraction_runtime.head ADD CONSTRAINT head_ack CHECK (acknowledgement IN ('QUEUED', 'RUNNING', 'PAUSED', 'STOPPED', 'FAILED', 'COMPLETED'));
ALTER TABLE extraction_runtime.head ADD CONSTRAINT head_versions CHECK ("controlVersion" >= 0 AND fence >= 0 AND "leaseEpoch" >= 0 AND generation >= 1 AND "snapshotVersion" >= 0);
ALTER TABLE extraction_runtime.head ADD CONSTRAINT head_strategy CHECK (strategy IN ('ARTICLE', 'CATALOG'));
ALTER TABLE extraction_runtime.selection ADD CONSTRAINT selection_digest CHECK (digest ~ '^[a-f0-9]{64}$' AND "schemaHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE extraction_runtime.input ADD CONSTRAINT input_digest CHECK (digest ~ '^[a-f0-9]{64}$');
ALTER TABLE extraction_runtime.checkpoint ADD CONSTRAINT checkpoint_digest CHECK ("inputDigest" ~ '^[a-f0-9]{64}$' AND "outputDigest" ~ '^[a-f0-9]{64}$');

CREATE FUNCTION extraction_runtime.content_hash(body jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT encode(sha256(convert_to(body::text, 'UTF8')), 'hex') $$;

CREATE FUNCTION extraction_runtime.valid_provider(provider jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(provider)='object'
    AND provider ?& ARRAY['key','model','adapter','adapterVersion','url','timeout','maxTokens']
    AND provider - ARRAY['key','model','adapter','adapterVersion','url','timeout','maxTokens','nativeInfo']='{}'::jsonb
    AND provider->>'key' ~ '^[a-zA-Z0-9_.:/-]{1,200}$'
    AND length(provider->>'model') BETWEEN 1 AND 300
    AND provider->>'adapter' IN ('instruct','nuextract','gliformer') AND provider->'adapterVersion'='1'::jsonb
    AND provider->>'url' ~ '^https?://[^@?#[:space:]]+$'
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

CREATE FUNCTION extraction_runtime.valid_value(node jsonb, value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE child jsonb; item jsonb; kind text := node->>'type';
BEGIN
  IF value IS NULL THEN RETURN false; END IF;
  IF value='null'::jsonb THEN RETURN true; END IF;
  IF kind IN ('verbatim-string','string','date','number','integer','boolean') THEN
    IF jsonb_typeof(value) IS DISTINCT FROM (CASE WHEN kind IN ('verbatim-string','date') THEN 'string' WHEN kind='integer' THEN 'number' ELSE kind END) THEN RETURN false; END IF;
    IF kind='integer' AND (value::text)::numeric <> trunc((value::text)::numeric) THEN RETURN false; END IF;
    RETURN (NOT node ? 'allowedValues' OR node->'allowedValues'='null'::jsonb
      OR jsonb_array_length(node->'allowedValues')=0 OR node->'allowedValues' @> jsonb_build_array(value));
  ELSIF kind='object' THEN
    IF jsonb_typeof(value)<>'object' OR jsonb_typeof(node->'children')<>'array' THEN RETURN false; END IF;
    FOR child IN SELECT * FROM jsonb_array_elements(node->'children') LOOP
      IF NOT extraction_runtime.valid_value(child,value->(child->>'name')) THEN RETURN false; END IF;
    END LOOP;
    RETURN NOT EXISTS (SELECT FROM jsonb_object_keys(value) k WHERE NOT EXISTS
      (SELECT FROM jsonb_array_elements(node->'children') c WHERE c->>'name'=k));
  ELSIF kind='array' THEN
    IF jsonb_typeof(value)<>'array' THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
      IF node ? 'itemType' THEN
        IF NOT extraction_runtime.valid_value(jsonb_build_object('type',node->'itemType'),item) THEN RETURN false; END IF;
      ELSE
        IF NOT extraction_runtime.valid_value(jsonb_set(node,'{type}','"object"'::jsonb),item) THEN RETURN false; END IF;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
END $$;

-- Internal guard. Not granted to the worker independently.
CREATE FUNCTION extraction_runtime.authorized(p_extraction uuid, p_attempt uuid, epoch integer)
RETURNS extraction_runtime.head LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head;
BEGIN
  SELECT * INTO h FROM extraction_runtime.head WHERE id = p_extraction FOR UPDATE;
  IF NOT FOUND OR epoch IS NULL OR h.deleted OR h."attemptId" IS DISTINCT FROM p_attempt OR h."leaseEpoch" <> epoch
      OR h."leaseUntil" IS NULL OR h."leaseUntil" <= clock_timestamp()
      OR NOT EXISTS (SELECT FROM extraction_runtime.attempt a WHERE a.id = p_attempt
          AND a."extractionId" = h.id AND a.fence = h.fence AND a."selectionId" = h."selectionId") THEN
    RAISE EXCEPTION 'stale execution authorization' USING ERRCODE = '40001';
  END IF;
  RETURN h;
END $$;

CREATE FUNCTION extraction_runtime.capabilities() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT jsonb_build_object('protocol', version) FROM extraction_runtime.protocol WHERE id = 1 $$;

CREATE FUNCTION extraction_runtime.claim(p_extraction uuid, p_attempt uuid, process uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; s extraction_runtime.selection;
BEGIN
  SELECT * INTO h FROM extraction_runtime.head WHERE id = p_extraction FOR UPDATE;
  IF NOT FOUND OR process IS NULL OR h.deleted OR h."attemptId" IS DISTINCT FROM p_attempt
      OR NOT EXISTS (SELECT FROM extraction_runtime.attempt a WHERE a.id = p_attempt AND a.fence = h.fence
          AND a."selectionId" = h."selectionId" AND a.outcome IS NULL) THEN
    RAISE EXCEPTION 'p_attempt is not current' USING ERRCODE = '40001';
  END IF;
  IF h."leaseUntil" > clock_timestamp() AND h."leaseOwner" IS DISTINCT FROM process THEN
    RAISE EXCEPTION 'execution lease is occupied' USING ERRCODE = '55P03';
  END IF;
  IF h."leaseOwner" IS DISTINCT FROM process OR h."leaseUntil" IS NULL OR h."leaseUntil" <= clock_timestamp() THEN
    h."leaseEpoch" := h."leaseEpoch" + 1;
    -- A lost native call may still return, but the expired epoch can no longer
    -- publish. Its unknown output is unfinished; recovery preserves its input.
    UPDATE extraction_runtime.capture SET "inFlight" = false WHERE "extractionId" = p_extraction;
  END IF;
  UPDATE extraction_runtime.head SET "leaseEpoch" = h."leaseEpoch", "leaseOwner" = process,
    "leaseUntil" = clock_timestamp() + interval '30 seconds', acknowledgement = 'RUNNING' WHERE id = p_extraction;
  SELECT * INTO s FROM extraction_runtime.selection WHERE id = h."selectionId" AND "extractionId" = p_extraction;
  RETURN jsonb_build_object('epoch', h."leaseEpoch", 'generation', h.generation, 'selection', to_jsonb(s),
    'source', h."sourcePin", 'intent', h.intent, 'snapshotVersion', h."snapshotVersion");
END $$;

CREATE FUNCTION extraction_runtime.heartbeat(p_extraction uuid, p_attempt uuid, epoch integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  UPDATE extraction_runtime.head SET "leaseUntil" = clock_timestamp() + interval '30 seconds' WHERE id = p_extraction;
  RETURN h.intent;
END $$;

CREATE FUNCTION extraction_runtime.publish_plan(p_extraction uuid, p_attempt uuid, epoch integer,
  identity uuid, stage text, manifest jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; p extraction_runtime.plan; d text;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  IF stage IS NULL OR length(stage) NOT BETWEEN 1 AND 128 OR jsonb_typeof(manifest) <> 'object'
     OR NOT (manifest ?& ARRAY['plannerVersion', 'selectionId', 'sourceGeneration', 'units', 'coverage'])
     OR manifest->>'selectionId' IS DISTINCT FROM h."selectionId"::text
     OR manifest->>'sourceGeneration' IS DISTINCT FROM h."sourcePin"->>'generation' THEN
    RAISE EXCEPTION 'invalid plan manifest' USING ERRCODE = '22023';
  END IF;
  d := extraction_runtime.content_hash(manifest);
  SELECT * INTO p FROM extraction_runtime.plan WHERE "extractionId" = p_extraction AND generation = h.generation AND plan.stage = publish_plan.stage;
  IF FOUND THEN
    IF p.digest <> d THEN RAISE EXCEPTION 'plan publication conflict' USING ERRCODE = '23505'; END IF;
    RETURN to_jsonb(p);
  END IF;
  IF h.intent <> 'RUN' THEN RETURN NULL; END IF;
  INSERT INTO extraction_runtime.plan (id,"extractionId",generation,stage,digest,manifest) VALUES (identity, p_extraction, h.generation, stage, d, manifest) RETURNING * INTO p;
  RETURN to_jsonb(p);
END $$;

CREATE FUNCTION extraction_runtime.capture_unit(p_extraction uuid, p_attempt uuid, epoch integer,
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
    IF h.intent <> 'RUN' AND NOT EXISTS (SELECT FROM extraction_runtime.checkpoint WHERE id=c.id) THEN RETURN NULL; END IF;
    UPDATE extraction_runtime.capture SET "reservationAttemptId" = p_attempt, "reservationEpoch" = epoch WHERE id = c.id;
    c."reservationAttemptId" := p_attempt; c."reservationEpoch" := epoch;
    RETURN to_jsonb(c) || jsonb_build_object('input', (SELECT to_jsonb(i) FROM extraction_runtime.input i WHERE i.id = c.id),
      'checkpoint', (SELECT to_jsonb(o) FROM extraction_runtime.checkpoint o WHERE o.id = c.id));
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

CREATE FUNCTION extraction_runtime.finalize_input(p_extraction uuid, p_attempt uuid, epoch integer,
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

CREATE FUNCTION extraction_runtime.begin_call(p_extraction uuid, p_attempt uuid, epoch integer, p_capture uuid) RETURNS boolean
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
  IF EXISTS (SELECT FROM extraction_runtime.checkpoint WHERE id = p_capture) THEN RETURN false; END IF;
  UPDATE extraction_runtime.capture SET "inFlight" = true, invoked = true WHERE id = p_capture;
  RETURN true;
END $$;

CREATE FUNCTION extraction_runtime.commit_output(p_extraction uuid, p_attempt uuid, epoch integer,
  p_capture uuid, input_digest text, output jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; c extraction_runtime.capture; o extraction_runtime.checkpoint; d text;
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
  IF NOT c."inFlight" THEN RAISE EXCEPTION 'call was not started' USING ERRCODE = '40001'; END IF;
  -- PAUSE and STOP deliberately allow outputs admitted before their command.
  INSERT INTO extraction_runtime.checkpoint (id,"inputDigest","outputDigest",output) VALUES (p_capture, input_digest, d, output) RETURNING * INTO o;
  UPDATE extraction_runtime.capture SET "inFlight" = false WHERE id = p_capture;
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION extraction_runtime.fail_call(p_extraction uuid, p_attempt uuid, epoch integer, p_capture uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  UPDATE extraction_runtime.capture SET "inFlight" = false WHERE id = p_capture AND "extractionId" = p_extraction
    AND "reservationAttemptId" = p_attempt AND "reservationEpoch" = epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'capture is not reserved' USING ERRCODE = '40001'; END IF;
  UPDATE extraction_runtime.head SET intent = CASE WHEN intent = 'STOP' THEN 'STOP' ELSE 'PAUSE' END WHERE id = p_extraction;
END $$;

CREATE FUNCTION extraction_runtime.publish_snapshot(p_extraction uuid, p_attempt uuid, epoch integer,
  identity uuid, selection uuid, body jsonb, coverage jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; s extraction_runtime.snapshot; d text; previous_coverage jsonb; retained_value jsonb; node jsonb; selected extraction_runtime.selection;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  IF selection IS DISTINCT FROM h."selectionId" OR jsonb_typeof(body) IS DISTINCT FROM 'array' OR jsonb_typeof(coverage) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid result snapshot' USING ERRCODE = '22023';
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
    coalesce(previous_coverage->'completedScopes','{}'::jsonb)||coalesce(coverage->'completedScopes','{}'::jsonb));
  d := extraction_runtime.content_hash(jsonb_build_object('values',body,'coverage',coverage));
  h."snapshotVersion" := h."snapshotVersion" + 1;
  INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES (identity, p_extraction, h."snapshotVersion", selection, d, body, coverage) RETURNING * INTO s;
  UPDATE extraction_runtime.head SET "snapshotVersion" = h."snapshotVersion" WHERE id = p_extraction;
  RETURN to_jsonb(s);
END $$;

CREATE FUNCTION extraction_runtime.acknowledge(p_extraction uuid, p_attempt uuid, epoch integer,
  complete boolean, failure jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; result text;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  IF EXISTS (SELECT FROM extraction_runtime.capture WHERE "extractionId" = p_extraction AND "inFlight") THEN
    RAISE EXCEPTION 'provider calls have not drained' USING ERRCODE = '55000';
  END IF;
  result := CASE WHEN h.intent = 'STOP' THEN 'STOPPED' WHEN complete THEN 'COMPLETED'
    WHEN failure IS NOT NULL THEN 'FAILED' WHEN h.intent = 'PAUSE' THEN 'PAUSED' ELSE NULL END;
  IF result IS NULL THEN RAISE EXCEPTION 'no idle boundary to acknowledge' USING ERRCODE = '55000'; END IF;
  UPDATE extraction_runtime.attempt SET outcome = result, failure = acknowledge.failure WHERE id = p_attempt;
  UPDATE extraction_runtime.head SET acknowledgement = result, "leaseOwner" = NULL, "leaseUntil" = NULL WHERE id = p_extraction;
  RETURN result;
END $$;


CREATE FUNCTION extraction_runtime.resolve_selection(p_extraction uuid, p_attempt uuid, epoch integer, configuration jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; e extraction_runtime.effective;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  SELECT * INTO e FROM extraction_runtime.effective WHERE id = h."selectionId";
  IF FOUND THEN RETURN to_jsonb(e); END IF;
  IF configuration IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(configuration) <> 'object' OR NOT (configuration ?& ARRAY['models','options','planner','protocols'])
    OR (configuration - ARRAY['models','options','planner','protocols']) <> '{}'::jsonb
    OR configuration->>'planner' IS DISTINCT FROM '1'
    OR configuration->'protocols'->>'calls' IS DISTINCT FROM '1'
    OR configuration->'protocols'->>'source' IS NULL OR configuration->'protocols'->>'source' NOT IN ('document','records')
    OR jsonb_typeof(configuration->'options') IS DISTINCT FROM 'object'
    OR NOT extraction_runtime.valid_provider(configuration->'models'->'fields')
    OR NOT extraction_runtime.valid_provider(configuration->'models'->'reasoning')
    OR (configuration->'models')-ARRAY['fields','reasoning']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'invalid effective configuration' USING ERRCODE = '22023';
  END IF;
  INSERT INTO extraction_runtime.effective (id,configuration,digest) VALUES (h."selectionId",configuration,extraction_runtime.content_hash(configuration)) RETURNING * INTO e;
  RETURN to_jsonb(e);
END $$;

CREATE FUNCTION extraction_runtime.read_call(p_extraction uuid, p_attempt uuid, epoch integer, identity uuid) RETURNS jsonb
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
    'checkpoint',(SELECT to_jsonb(o) FROM extraction_runtime.checkpoint o WHERE o.id=identity));
END $$;

CREATE FUNCTION extraction_runtime.historical_coverage(p_extraction uuid, p_attempt uuid, epoch integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head; p extraction_runtime.plan;
BEGIN
  h := extraction_runtime.authorized(p_extraction, p_attempt, epoch);
  SELECT * INTO p FROM extraction_runtime.plan WHERE "extractionId"=p_extraction AND generation=h.generation AND stage='historical-coverage';
  IF NOT FOUND THEN RAISE EXCEPTION 'historical coverage was not pinned' USING ERRCODE = '55000'; END IF;
  RETURN to_jsonb(p) || jsonb_build_object('snapshot',(SELECT to_jsonb(s) FROM extraction_runtime.snapshot s WHERE s.id=(p.manifest->'coverage'->>'snapshotId')::uuid));
END $$;

CREATE FUNCTION extraction_runtime.immutable_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'immutable Extraction history' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER selection_immutable BEFORE UPDATE ON extraction_runtime.selection FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE TRIGGER effective_immutable BEFORE UPDATE ON extraction_runtime.effective FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE TRIGGER plan_immutable BEFORE UPDATE ON extraction_runtime.plan FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE TRIGGER input_immutable BEFORE UPDATE ON extraction_runtime.input FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE TRIGGER checkpoint_immutable BEFORE UPDATE ON extraction_runtime.checkpoint FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE TRIGGER snapshot_immutable BEFORE UPDATE ON extraction_runtime.snapshot FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE TRIGGER correction_immutable BEFORE UPDATE ON extraction_runtime.correction FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();
CREATE TRIGGER finalization_immutable BEFORE UPDATE ON extraction_runtime.finalization FOR EACH ROW EXECUTE FUNCTION extraction_runtime.immutable_record();

CREATE FUNCTION extraction_runtime.preserve_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_NAME = 'capture' AND (to_jsonb(NEW) - ARRAY['reservationAttemptId','reservationEpoch','inFlight','invoked'])
    <> (to_jsonb(OLD) - ARRAY['reservationAttemptId','reservationEpoch','inFlight','invoked']) THEN
    RAISE EXCEPTION 'immutable capture attribution' USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'attempt' AND (to_jsonb(NEW) - ARRAY['outcome','failure']) <> (to_jsonb(OLD) - ARRAY['outcome','failure']) THEN
    RAISE EXCEPTION 'immutable attempt attribution' USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'head' AND jsonb_build_array(to_jsonb(NEW)->'id',to_jsonb(NEW)->'projectId',
    to_jsonb(NEW)->'sourceRevisionId',to_jsonb(NEW)->'sourcePin',to_jsonb(NEW)->'strategy')
    IS DISTINCT FROM jsonb_build_array(to_jsonb(OLD)->'id',to_jsonb(OLD)->'projectId',
    to_jsonb(OLD)->'sourceRevisionId',to_jsonb(OLD)->'sourcePin',to_jsonb(OLD)->'strategy') THEN
    RAISE EXCEPTION 'immutable Extraction source and strategy' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_origin BEFORE UPDATE ON extraction_runtime.capture FOR EACH ROW EXECUTE FUNCTION extraction_runtime.preserve_origin();
CREATE TRIGGER attempt_origin BEFORE UPDATE ON extraction_runtime.attempt FOR EACH ROW EXECUTE FUNCTION extraction_runtime.preserve_origin();
CREATE TRIGGER head_origin BEFORE UPDATE ON extraction_runtime.head FOR EACH ROW EXECUTE FUNCTION extraction_runtime.preserve_origin();
CREATE FUNCTION extraction_runtime.read_latest_snapshot(p_extraction uuid, p_attempt uuid, epoch integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE h extraction_runtime.head;
BEGIN
  h := extraction_runtime.authorized(p_extraction,p_attempt,epoch);
  RETURN (SELECT to_jsonb(s) FROM extraction_runtime.snapshot s WHERE s."extractionId"=p_extraction AND s.version=h."snapshotVersion");
END $$;
DO $ownership$
DECLARE fn record;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'extraction_runtime' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO free_extraction_runtime', fn.name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.name);
  END LOOP;
END $ownership$;
