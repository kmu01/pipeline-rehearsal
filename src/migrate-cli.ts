import { connectWithRetry, pool } from './db/client';
import { migrate } from './db/migrate';

async function main(): Promise<void> {
  await connectWithRetry(pool);
  const applied = await migrate();
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err.message);
  await pool.end();
  process.exit(1);
});