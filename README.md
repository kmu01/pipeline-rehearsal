# Ingestion pipeline

Loads client order, refund, email-event and ad-spend batches into Postgres, with crash-safe
replay, a per-tenant config (no client-specific code), schema-drift handling, a manifest check
for missing batches, and tenant isolation enforced by row-level security. Tested against a real
Postgres throughout, and against the client's real fixtures.

## What's finished

- Raw ingestion: one file's rows and its ledger row commit in a single transaction, so a crash
  leaves no trace and a re-run picks up cleanly (`src/ingest/load-file.ts`).
- Replay safety: a file already loaded is skipped; the same name with different bytes is refused,
  not silently reloaded.
- Multi-tenant config: `config/tenants/*.yaml`, validated at startup.
- Schema drift: a file's header is checked against the tenant's config. A column renamed to
  something declared under `aliases` is adapted; anything else is quarantined with a clear reason,
  and every decision is recorded (`schema_drift_events`). On the real fixtures, this correctly
  adapted the known `spend` → `cost_usd` rename in both tenants' ad-spend files with zero
  quarantines, because the config already declared it.
- The manifest check: compares `fixtures/manifest.json` against what's actually been loaded,
  reports what's missing, exits non-zero (`npm run check`).
- Tenant isolation enforced at the database level with row-level security (not just composite
  keys), including a guard test that scans for any table missing it.

## What's not built

Modelling raw data into staging/queryable tables, and NDJSON parsing (`email_events` is
JSON-lines; the loader currently only parses CSV). See `TRADEOFFS.md` for the plan and reasoning.

## Requirements

- Node 20+
- Podman (or Docker) with `podman compose` / `docker compose`

## Setup

```bash
podman compose up -d
npm ci
npm run migrate
```

`npm run migrate` creates two roles: `pipeline_admin` (the container's superuser, used only for
migrations) and `pipeline_app` (a restricted role with row-level security enforced against it,
used for everything else). It's safe to run repeatedly.

No `.env` file is needed unless you change the credentials or port in `docker-compose.yml` — see
`.env.example` for what each variable does.

## Load the real fixtures

Put the fixtures folder (containing `manifest.json`, `lumen/`, `northwind/`) at `./fixtures`, or
pass its path as an argument below.

```bash
npx tsx src/load-fixtures.ts ./fixtures
```

This walks `manifest.json` in order and loads every batch that's on disk. A batch not on disk is
reported as `MISSING`; a file whose format the loader can't parse (currently: NDJSON) is reported
as `FAILED` without stopping the rest of the run; a file whose header doesn't match the tenant's
config is `QUARANTINED`. Run against the real fixtures:

```
40 expected: 29 loaded, 0 quarantined, 0 already loaded, 1 missing, 0 refused, 10 failed to parse
```

The 10 failures are all `email_events` (NDJSON, not yet supported). The 1 missing batch is
`lumen/ad_spend/batch_03.csv`, which genuinely never arrives in this client's fixtures.

Then check whether every batch the manifest promises has actually arrived:

```bash
npm run check -- ./fixtures
```

Exit code `0` means everything arrived; `2` means at least one batch needs attention.

## Tests

```bash
npm test          # 44 passing (7 test files), needs the database running
npm run typecheck
```

Tests use throwaway tenant ids (`sch_test_*`, `load_test_*`, `check_test_*`, `rls_test_*`,
`drift_test_*`) and clean up after themselves; they don't touch fixture data loaded via
`load-fixtures.ts`.

## Project layout

```
config/tenants/*.yaml       per-client config: expected columns, declared column aliases
migrations/*.sql            versioned, applied in order by `npm run migrate`
src/db/                     connection pools (admin + restricted app role), migration runner
src/config/loader.ts        tenant config loading and validation
src/ingest/load-file.ts     the core: one file, one transaction, replay-safe, drift-aware
src/ingest/check-header.ts  compares a file's header to tenant config: adapt, quarantine, or pass
src/audit/                  manifest reading and the arrival check
test/                       one file per concern; test/rls.test.ts proves tenant isolation
```

## Known limitations

- Only CSV is parsed; `email_events` (NDJSON) is not yet ingested.
- No staging/modelling layer: raw JSON isn't turned into typed, queryable tables.
- A file that's refused for having changed under the same name still shows as "arrived" in
  `npm run check`, since arrival only checks that a ledger row exists, not that it matches what's
  currently on disk.
- The admin role can read across tenants; that's inherent to needing an owner for migrations. It
  is used only by `npm run migrate`.
