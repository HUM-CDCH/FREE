-- Run with psql -v project=<ProjectContext UUID> -f queries.sql against the Spark's free database.
-- No query below changes application data. The final role probe requires SQLSTATE 42501.
\set ON_ERROR_STOP on

SELECT workflow_uuid, name, status, queue_name, created_at, completed_at, attributes
FROM dbos.workflow_status
WHERE attributes @> jsonb_build_object('projectContextId', :'project')
ORDER BY created_at DESC;

SELECT workflow_uuid, name, status, queue_name, created_at, completed_at, attributes
FROM kei_dbos.workflow_status
WHERE attributes @> jsonb_build_object('projectContextId', :'project')
ORDER BY created_at DESC;

SELECT workflow_uuid, queue_name, status, to_timestamp(completed_at / 1000.0) AS completed_at
FROM kei_dbos.workflow_status
WHERE workflow_uuid LIKE 'kei-%'
ORDER BY created_at DESC
LIMIT 20;

SELECT * FROM dbos.workflow_schedules ORDER BY workflow_name;

SELECT usename, application_name, state, count(*)
FROM pg_stat_activity WHERE datname = 'free'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- Same rule as Studio's orphanPayloadRows test helper, for both DBOS schemas.
DO $$
DECLARE
    schema_name text;
    table_name text;
    orphan_count bigint;
BEGIN
    FOREACH schema_name IN ARRAY ARRAY['dbos', 'kei_dbos'] LOOP
        FOR table_name IN
            SELECT c.table_name FROM information_schema.columns c
            WHERE c.table_schema = schema_name
              AND c.column_name = 'workflow_uuid'
              AND c.table_name <> 'workflow_status'
            ORDER BY c.table_name
        LOOP
            EXECUTE format(
                'SELECT count(*) FROM %I.%I t WHERE NOT EXISTS '
                || '(SELECT 1 FROM %I.workflow_status s WHERE s.workflow_uuid = t.workflow_uuid)',
                schema_name, table_name, schema_name
            ) INTO orphan_count;
            RAISE NOTICE 'orphan payload rows %.%: %', schema_name, table_name, orphan_count;
        END LOOP;
    END LOOP;
END
$$;

-- The inner SELECT must fail with SQLSTATE 42501; any successful read aborts this script.
SET ROLE kei;
DO $$
BEGIN
    BEGIN
        PERFORM 1 FROM public."projectContext" LIMIT 1;
        RAISE EXCEPTION 'kei unexpectedly read public.projectContext';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'kei projectContext read denied (SQLSTATE %)', SQLSTATE;
    END;
END
$$;
RESET ROLE;
