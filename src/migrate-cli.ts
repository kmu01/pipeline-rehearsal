import { adminPool, connectWithRetry } from './db/client';
import { migrate } from './db/migrate';

async function main(): Promise<void> {
  await connectWithRetry(adminPool);
  const applied = await migrate();
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  await adminPool.end();
}

main().catch(async (err) => {
  console.error(err.message);
  await adminPool.end();
  process.exit(1);
});