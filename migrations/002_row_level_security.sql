-- 002_row_level_security.sql
-- Composite keys stop two tenants' DATA from colliding. They do nothing to stop a QUERY
-- that forgets "WHERE tenant_id = ..." from reading every tenant's rows. This migration closes
-- that gap at the database level, so a forgetful query gets an empty or restricted result instead
-- of someone else's data -- no matter what the application code does or forgets to do.

-- The pipeline_app role itself is created by migrate.ts, not here, so its password can come from
-- APP_DB_PASSWORD (an environment variable) instead of being committed in a SQL file. By the time
-- this migration runs, migrate.ts has already created it with NOSUPERUSER and NOBYPASSRLS -- the
-- two flags that matter: without them, this role would ignore row-level security exactly like the
-- admin role does.

-- ENABLE turns RLS on for ordinary roles. FORCE makes it apply even to the table's OWNER (which
-- would otherwise be exempt). Without FORCE, a role that happens to own the table slips through.
ALTER TABLE file_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE raw_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_records FORCE ROW LEVEL SECURITY;

-- USING controls which existing rows a query can see; WITH CHECK controls which rows a write is
-- allowed to create or leave behind. Both compare the row's tenant_id to a per-connection setting
-- the application sets for the current transaction (see withTenant in client.ts).
-- current_setting(..., true) with true as the 2nd argument returns NULL instead of erroring when
-- nothing was set, so a connection that forgot to set a tenant sees zero rows, not an error.
CREATE POLICY tenant_isolation ON file_ledger
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

CREATE POLICY tenant_isolation ON raw_records
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

-- Granting SELECT/INSERT to pipeline_app happens in migrate.ts, after every migration file runs,
-- not here -- that way a table a LATER migration adds is still reachable without a manual step.