-- =============================================================
-- SmartSearch Auto — Supabase migration
-- Schema: awm_smartsearch  (per AWM STANDARDS_AND_RULES.md)
--
-- NOTE: On the shared AWM instance, schema creation is Colin's job —
-- register `awm_smartsearch` in the Notion Tool Registry and confirm
-- with him. The CREATE SCHEMA below is idempotent so this file also
-- runs cleanly on a dev/own instance.
--
-- AFTER running this file, one dashboard step is required for the app
-- to reach the table via the API:
--   Settings -> API -> "Exposed schemas" -> add `awm_smartsearch`
-- Then push existing local records with:  npm run sync-supabase
-- =============================================================

CREATE SCHEMA IF NOT EXISTS awm_smartsearch;

-- PostgREST/service-role access to the schema and its objects
GRANT USAGE ON SCHEMA awm_smartsearch TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA awm_smartsearch
    GRANT ALL ON TABLES TO service_role;

-- Enum: where a record came from (never plain TEXT for controlled values)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'record_source_type' AND n.nspname = 'awm_smartsearch'
    ) THEN
        CREATE TYPE awm_smartsearch.record_source_type AS ENUM (
            'app_pipeline',
            'insightly_backfill'
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS awm_smartsearch.smartsearch_records (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,

    -- unique app-side key: Asana task gid, or 'insightly-{id}' for backfill
    record_key          TEXT NOT NULL UNIQUE,

    -- client link (universal AWM identifier -> public.insightly_contacts)
    insightly_id        TEXT NOT NULL,
    contact_name        TEXT,

    -- Asana
    task_name           TEXT,
    task_url            TEXT,

    -- SmartSearch dates
    conducted_date      DATE,
    expiry_date         DATE,

    -- Google Drive
    drive_url           TEXT,
    file_name           TEXT,
    folder_name         TEXT,

    -- Insightly write-back
    insightly_url       TEXT,
    insightly_verified  BOOLEAN DEFAULT false NOT NULL,
    insightly_expiry    TEXT,

    source              awm_smartsearch.record_source_type DEFAULT 'app_pipeline' NOT NULL,
    processed_at        TIMESTAMPTZ,
    reminder_dismissed  BOOLEAN DEFAULT false NOT NULL,

    -- FCA soft-delete pattern (client data — never hard delete)
    is_deleted          BOOLEAN DEFAULT false NOT NULL,
    deleted_at          TIMESTAMPTZ,
    deletion_reason     TEXT,

    created_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at          TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smartsearch_records_insightly_id
    ON awm_smartsearch.smartsearch_records (insightly_id);
CREATE INDEX IF NOT EXISTS idx_smartsearch_records_expiry_date
    ON awm_smartsearch.smartsearch_records (expiry_date);

GRANT ALL ON awm_smartsearch.smartsearch_records TO service_role;

-- RLS: backend (service role) only
ALTER TABLE awm_smartsearch.smartsearch_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON awm_smartsearch.smartsearch_records;
CREATE POLICY "service_role_full_access"
    ON awm_smartsearch.smartsearch_records FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- Verification (run after): enums exist in schema
-- SELECT typname, nspname FROM pg_type t
-- JOIN pg_namespace n ON n.oid = t.typnamespace
-- WHERE t.typtype = 'e' AND nspname = 'awm_smartsearch';
