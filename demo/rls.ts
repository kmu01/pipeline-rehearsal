import { withTenant, appPool, adminPool } from '../src/db/client';

async function main() {
  await adminPool.query(`DELETE FROM raw_records WHERE tenant_id IN ('lumen','northwind')`);
  await adminPool.query(`DELETE FROM file_ledger WHERE tenant_id IN ('lumen','northwind')`);
  await adminPool.query(`INSERT INTO file_ledger (tenant_id,file_id,source,file_hash,row_count) VALUES ('lumen','a.csv','orders','x',1),('northwind','b.csv','orders','y',1)`);

  console.log('Connected AS the lumen tenant, querying file_ledger with no WHERE clause at all:');
  const rows = await withTenant('lumen', (c) => c.query('SELECT tenant_id, file_id FROM file_ledger').then((r) => r.rows));
  console.log(rows);
  console.log("(northwind's row exists in the table, but is invisible from here)");
  await adminPool.end();
  await appPool.end();
}
main();