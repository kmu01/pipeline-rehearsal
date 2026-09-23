import { connectWithRetry, pool } from './db/client';
import { checkArrivals, describeArrivals, exitCodeFor } from './audit/check-arrivals';

async function main(): Promise<void> {
  const fixturesRoot = process.argv[2] ?? './fixtures';
  await connectWithRetry(pool);
  const reports = await checkArrivals(fixturesRoot);
  for (const line of describeArrivals(reports)) console.log(line);
  await pool.end();
  process.exit(exitCodeFor(reports));
}

main().catch(async (err) => {
  console.error(err.message);
  await pool.end();
  process.exit(1);
});