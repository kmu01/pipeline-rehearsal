import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, appPool, withTenant } from '../src/db/client';
import { migrate } from '../src/db/migrate';

const A = 'rls_test_a';
const B = 'rls_test_b';

beforeAll(async () => {
  await migrate();
  await adminPool.query(`DELETE FROM raw_records WHERE tenant_id = ANY($1)`, [[A, B]]);
  await adminPool.query(`DELETE FROM file_ledger WHERE tenant_id = ANY($1)`, [[A, B]]);
  // Seeded as admin (which bypasses RLS): both tenants get a ledger row for the SAME file_id.
  // This mirrors your real fixtures, where an orphan refund id repeats across tenants.
  await adminPool.query(
    `INSERT INTO file_ledger (tenant_id, file_id, source, file_hash, row_count) VALUES ($1,'orders/batch_01.csv','orders','h1',1),($2,'orders/batch_01.csv','orders','h2',1)`,
    [A, B],
  );
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM raw_records WHERE tenant_id = ANY($1)`, [[A, B]]);
  await adminPool.query(`DELETE FROM file_ledger WHERE tenant_id = ANY($1)`, [[A, B]]);
  await adminPool.end();
  await appPool.end();
});

describe('the app role is genuinely restricted, not just conventionally careful', () => {
  it('is not a superuser and cannot bypass row-level security', async () => {
    const { rows } = await adminPool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'pipeline_app'`);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('row-level security enforces the tenant boundary', () => {
  it('a tenant sees only its own rows, even though another tenant has a row with the SAME file_id', async () => {
    const rows = await withTenant(A, (client) => client.query('SELECT tenant_id FROM file_ledger').then((r) => r.rows));
    expect(rows).toEqual([{ tenant_id: A }]); // not B's row, even though it shares the same file_id
  });

  it('a query with no tenant selected sees nothing at all -- not "everything", not an error', async () => {
    const { rows } = await appPool.query('SELECT count(*)::int AS n FROM file_ledger');
    expect(rows[0].n).toBe(0);
  });

  it('one tenant cannot write a row claiming to belong to another tenant', async () => {
    await expect(
      withTenant(A, (client) =>
        client.query(`INSERT INTO file_ledger (tenant_id, file_id, source, file_hash, row_count) VALUES ($1,'sneaky.csv','orders','h3',1)`, [B])),
    ).rejects.toThrow(/row-level security/);
  });

  it('the tenant setting does not leak to the next user of a pooled connection', async () => {
    await withTenant(A, (client) => client.query('SELECT 1'));
    const { rows } = await appPool.query(`SELECT current_setting('app.current_tenant', true) AS t`);
    expect(rows[0].t ?? '').toBe(''); // cleared, not still "rls_test_a"
  });

  it('GUARD: every table with a tenant_id column actually has row-level security forced and a policy -- not just some of them', async () => {
    const { rows } = await adminPool.query(`
      SELECT c.relname FROM pg_class c
      JOIN information_schema.columns k ON k.table_name = c.relname AND k.column_name = 'tenant_id' AND k.table_schema = 'public'
      WHERE c.relkind = 'r'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity
                 AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation'))
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});