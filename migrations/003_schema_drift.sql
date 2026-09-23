-- 003_schema_drift.sql

-- A file that quarantines still gets a ledger row (so it isn't silently retried every run), it is
-- just marked QUARANTINED instead of LOADED. This is how `npm run check` tells apart
-- "never arrived" from "arrived, but something is wrong with it". `detail` carries WHY.
ALTER TABLE file_ledger ADD COLUMN status text NOT NULL DEFAULT 'LOADED' CHECK (status IN ('LOADED', 'QUARANTINED'));
ALTER TABLE file_ledger ADD COLUMN detail text;

-- One row per column the pipeline had to think about: either it adapted (a declared alias fired)
-- or it refused (a column could not be matched to anything expected). canonical_column is
-- nullable: for an unexplained column found during a quarantine (the pipeline's best guess at
-- what a rename produced), there is no canonical name to attach it to yet.
CREATE TABLE schema_drift_events (
    id                bigserial   PRIMARY KEY,
    tenant_id         text        NOT NULL,
    file_id           text        NOT NULL,
    source            text        NOT NULL,
    original_column   text        NOT NULL,
    canonical_column  text,
    action            text        NOT NULL CHECK (action IN ('ALIASED', 'QUARANTINED')),
    detected_at       timestamptz NOT NULL DEFAULT now()
);

-- Same as every other tenant table: enable and FORCE row-level security, and a policy.
-- Forgetting this is exactly what test/rls.test.ts's GUARD check exists to catch.
ALTER TABLE schema_drift_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_drift_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schema_drift_events
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));