import { connectWithRetry, pool } from './db/client';

async function main(): Promise<void> {
  await connectWithRetry(pool);
  const { rows } = await pool.query('SELECT version() AS version, now() AS now');
  console.log(`Connected. ${String(rows[0].version).split(',')[0]}`);
  console.log(`Database clock: ${rows[0].now.toISOString()}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});