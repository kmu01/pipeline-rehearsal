-- 001_ledger_and_raw.sql
-- Every table has tenant_id, and it is the FIRST column of every key. That is what stops two clients
-- from colliding when they happen to use the same file name or the same id.

-- One row per file that was loaded completely. Written in the SAME transaction as the file's rows
-- (step 4), so a row here means "this whole file is in the database". Never "part of it".
CREATE TABLE file_ledger (
    tenant_id   text        NOT NULL,
    file_id     text        NOT NULL,             -- the file's path, relative to the fixtures folder
    source      text        NOT NULL,             -- orders | refunds | email_events | ad_spend
    file_hash   text        NOT NULL,             -- sha256 of the file's bytes: detects "same name, different content"
    row_count   int         NOT NULL,
    loaded_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, file_id)
);

-- Exactly what arrived, one row per record, with the source's own column names kept as they were.
-- jsonb stores the record as-is, so a renamed column never breaks loading; it is dealt with later.
CREATE TABLE raw_records (
    tenant_id   text        NOT NULL,
    file_id     text        NOT NULL,
    line_no     int         NOT NULL,             -- the record's 1-based position within its file
    source      text        NOT NULL,
    payload     jsonb       NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, file_id, line_no),
    -- A raw row must belong to a ledger row OF THE SAME TENANT. Because tenant_id is part of the
    -- foreign key, a row cannot point at another client's file even by mistake.
    FOREIGN KEY (tenant_id, file_id) REFERENCES file_ledger (tenant_id, file_id)
);