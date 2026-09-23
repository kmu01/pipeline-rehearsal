# Tradeoffs

## How I decided what to build

Before writing any code, I used an AI coding assistant to help write a script that profiles the
fixtures: every file, both tenants, checking for duplicates, overlapping batches, schema
changes, and gaps against the manifest. From a previous exercise I'd learned that this kind of
tool is genuinely good at spotting these inconsistencies, better than I tend to be scanning
files by eye, so I leaned on it deliberately here rather than working purely from intuition.
Almost every decision below traces back to what that profile actually found.

It found:
- Both tenants' `ad_spend` files rename a column (`spend` → `cost_usd`) starting at batch 4.
- Northwind's orders batch 3 re-sends 14 rows already delivered in batch 2 (an overlapping
  export).
- `lumen/ad_spend/batch_03.csv` is listed in the manifest but never actually arrives.
- Each tenant has 6 refunds pointing at an order that doesn't exist (orphans), and the same
  refund IDs are reused across both tenants.
- The client's own `finance_summary.csv` reconciles to the cent against the raw order data once
  duplicates are removed.

Running the finished pipeline against the real fixtures confirmed this directly: one genuinely
missing batch, refund counts (32 for lumen, 33 for northwind) matching the profiler exactly, and
the known column rename adapted cleanly in both tenants with zero files needing quarantine.

## What I prioritized

Replay safety and tenant isolation, done properly, rather than a wider set of features done
thinly. A file's rows and its "this file is loaded" record are written together, so a crash
mid-file can never leave the database in a half-loaded, ambiguous state, and a file with the
same name but different content is refused rather than guessed at. Tenant isolation is enforced
by Postgres itself: a query that forgets to filter by client still cannot see another client's
data. The manifest check is built on the same ledger as everything else, so "did this source
arrive" is answered from a single source of truth.

I also built schema-drift handling, since the profiler had already found a real case of it (the
`spend` → `cost_usd` rename) rather than a hypothetical one. A file's header is checked against
the tenant's config: a rename the config declares is adapted and logged; anything else is
quarantined with a reason, never guessed at silently. Running this against the real fixtures
confirmed the declared rename adapts cleanly with no quarantines, and the audit log shows exactly
which files and columns were affected.

## What I didn't build

- **Turning raw data into clean, queryable tables.** Right now the pipeline proves data arrived
  correctly and safely. It doesn't yet reshape that data into the kind of tables a client would
  actually query for reporting. This is the biggest missing piece, and it's what I'd build next.
- **The `email_events` files** (NDJSON, one JSON record per line). The loader only reads CSV.
  Running it against the real fixtures confirmed this cleanly: all 10 email-event batches fail
  with one clear, expected error each, with no effect on anything else in the run.

## Adding a third client

A new client is just a new configuration file. The file declares its expected columns
and any known renames; nothing in the pipeline mentions a client by name. I proved this by
adding a throwaway third client this way and watching it get picked up automatically.

## The hardest part

Enforcing tenant isolation at the database level was deceptively hard to trust, not just to build. 
My first attempt at proving it worked didn't actually prove anything: fixing a client's database settings automatically every time the app starts is a real feature, but it also quietly undid my deliberately broken test case before I ever saw it fail. 
On top of that, a superuser connection bypasses this kind of protection entirely, which is a separate trap for the same reason. I only trusted the isolation once I changed the setup code itself so it couldn't self-heal, and watched the tests catch it for real. I also added a check that scans every table for this protection automatically, so a table added later can't be forgotten.

## With another week

1. Build the layer that turns raw data into clean daily numbers per client, including handling
   records that arrive late for a day that was already reported.
2. Add the NDJSON parser for email events. The pipeline's transaction and ledger model already supports it; it only needs a streaming JSON line parser plugged alongside the CSV reader.
3. Fix a small gap I found while testing: if a file is refused for having changed unexpectedly,
   the "did this batch arrive" check still reports it as arrived, since it only checks that a
   record exists, without checking that it matches what's currently on disk.
4. Extend drift handling to alert on new values appearing in a column, since so far it only
   watches for a column being renamed.
