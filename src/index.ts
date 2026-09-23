import { adminPool, connectWithRetry } from './db/client';

async function main(): Promise<void> {
  await connectWithRetry(adminPool);
  const { rows } = await adminPool.query('SELECT version() AS version, now() AS now');
  console.log(`Connected. ${String(rows[0].version).split(',')[0]}`);
  console.log(`Database clock: ${rows[0].now.toISOString()}`);
  await adminPool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});