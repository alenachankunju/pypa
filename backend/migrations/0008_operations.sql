-- =============================================================================
-- 0008_operations.sql
-- Bulk import staging and database snapshots.
--
-- FSD references:
--   5.2  ADM-02-05  Bulk import of churches from CSV with a validation preview
--   5.5  ADM-05-07  Bulk import of members with a validation preview
--   5.15 ADM-15-02 .. ADM-15-05  Backup, snapshot, export, restore
--   12.2 "Nothing is written until the administrator reviews the preview."
-- =============================================================================

-- -----------------------------------------------------------------------------
-- import_batches -- a staged CSV/XLSX upload awaiting administrator review.
--
-- The two-phase shape is the requirement, not a convenience: ADM-02-05 and
-- ADM-05-07 both demand "a validation preview showing accepted and rejected rows
-- BEFORE anything is written", and 12.2 confirms "valid rows may be committed
-- while invalid rows are exported for correction".
-- -----------------------------------------------------------------------------
CREATE TABLE import_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  type           import_batch_type NOT NULL,
  status         import_batch_status NOT NULL DEFAULT 'PENDING_REVIEW',

  filename       text,
  total_rows     integer NOT NULL DEFAULT 0,
  valid_rows     integer NOT NULL DEFAULT 0,
  invalid_rows   integer NOT NULL DEFAULT 0,
  committed_rows integer NOT NULL DEFAULT 0,

  committed_at   timestamptz,
  committed_by   uuid REFERENCES users(id),
  discarded_at   timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_by     uuid REFERENCES users(id)
);

CREATE INDEX import_batches_event_idx  ON import_batches (event_id, created_at DESC);
CREATE INDEX import_batches_status_idx ON import_batches (status);

CREATE TRIGGER import_batches_set_updated_at
  BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- import_rows -- one staged row with its validation verdict.
--
-- ADM-05-07: the preview must report, per row: invalid church, duplicate chest
-- number, ineligible item, malformed date of birth. errors is an array of
-- { field, code, message } so the preview table can highlight the offending cell
-- rather than only flagging the row.
-- -----------------------------------------------------------------------------
CREATE TABLE import_rows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number  integer NOT NULL,
  raw         jsonb NOT NULL,
  normalised  jsonb,
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      import_row_status NOT NULL DEFAULT 'VALID',
  created_entity_id uuid,

  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX import_rows_batch_row_key ON import_rows (batch_id, row_number);
CREATE INDEX import_rows_batch_status_idx     ON import_rows (batch_id, status);


-- -----------------------------------------------------------------------------
-- snapshots -- point-in-time logical backups. FSD 5.15.
--
-- ADM-15-02: automatic backup on a schedule (recommended every 15 minutes on
--            event days) -- driven by a scheduled function, recorded here.
-- ADM-15-03: manual "snapshot now", intended for use immediately before any
--            bulk or destructive operation.
-- ADM-15-05: restore is restricted to Super Admin with a hard confirmation.
--
-- The payload itself is written to object storage; this table holds the
-- catalogue entry, the checksum and the provenance.
-- -----------------------------------------------------------------------------
CREATE TABLE snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,
  label         text,
  trigger       text NOT NULL,          -- 'SCHEDULED' | 'MANUAL' | 'PRE_BULK_OPERATION'

  storage_path  text,
  size_bytes    bigint,
  checksum      text,
  table_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,

  status        text NOT NULL DEFAULT 'PENDING',  -- PENDING | READY | FAILED
  error_message text,

  restored_at   timestamptz,
  restored_by   uuid REFERENCES users(id),

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  expires_at    timestamptz
);

CREATE INDEX snapshots_event_idx  ON snapshots (event_id, created_at DESC);
CREATE INDEX snapshots_status_idx ON snapshots (status);

COMMENT ON TABLE snapshots IS
  'Catalogue of logical backups. Payloads live in object storage; 11.4 requires retention of at least 30 days.';
