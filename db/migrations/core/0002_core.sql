-- Core: device catalog, vehicles, devices, positions, current state and audit log.
-- Every business row carries the account (org_id) it belongs to.

-- ─── Device catalog ──────────────────────────────────────────────────────────
-- Maintained by the backend at startup (apps/server/src/core/catalog.ts).
CREATE TABLE gps.device_models (
  id          text PRIMARY KEY,
  brand       text NOT NULL,
  name        text NOT NULL,
  examples    text NOT NULL DEFAULT '',
  protocol    text NOT NULL,
  port        integer NOT NULL,
  id_label    text NOT NULL DEFAULT 'IMEI',
  setup       jsonb NOT NULL DEFAULT '[]',
  sort_order  integer NOT NULL DEFAULT 0,
  enabled     boolean NOT NULL DEFAULT true
);

-- ─── Vehicles ────────────────────────────────────────────────────────────────
CREATE TABLE gps.vehicles (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  plate       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_org_idx ON gps.vehicles (org_id, created_at);

-- ─── GPS devices ─────────────────────────────────────────────────────────────
-- An identifier (IMEI) belongs to a single account. Registration stays pending
-- until the device sends its first report within the allowed time.
CREATE TABLE gps.devices (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id         uuid NOT NULL UNIQUE REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  unique_id          text NOT NULL UNIQUE,
  model_id           text NOT NULL REFERENCES gps.device_models (id),
  traccar_device_id  integer NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  claim_expires_at   timestamptz,
  confirmed_at       timestamptz,
  created_by         text
);
CREATE INDEX devices_org_idx ON gps.devices (org_id);
CREATE INDEX devices_pending_idx ON gps.devices (claim_expires_at) WHERE status = 'pending';

-- ─── Positions ───────────────────────────────────────────────────────────────
-- Each position is stored only once: device, GPS time and content checksum.
CREATE TABLE gps.positions (
  device_id    bigint NOT NULL,
  fix_time     timestamptz NOT NULL,
  hash         bigint NOT NULL,
  received_at  timestamptz NOT NULL,
  valid        boolean NOT NULL,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  altitude     real,
  speed_kmh    real,
  course       real,
  accuracy     real,
  protocol     text,
  attributes   jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (device_id, fix_time, hash)
);
SELECT create_hypertable('gps.positions', by_range('fix_time', INTERVAL '7 days'));
ALTER TABLE gps.positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'fix_time DESC'
);
SELECT add_compression_policy('gps.positions', INTERVAL '14 days');

-- ─── Current state per device ────────────────────────────────────────────────
CREATE TABLE gps.device_state (
  device_id     bigint PRIMARY KEY REFERENCES gps.devices (id) ON DELETE CASCADE,
  last_seen_at  timestamptz NOT NULL,
  fix_time      timestamptz,
  lat           double precision,
  lon           double precision,
  altitude      real,
  speed_kmh     real,
  course        real,
  accuracy      real,
  ignition      boolean,
  motion        boolean,
  attributes    jsonb NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── Traccar read progress ───────────────────────────────────────────────────
CREATE TABLE gps.ingest_cursor (
  source      text PRIMARY KEY,
  last_id     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─── Audit log ───────────────────────────────────────────────────────────────
CREATE TABLE gps.audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  org_id     text,
  user_id    text,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  detail     jsonb NOT NULL DEFAULT '{}',
  ip         text
);
CREATE INDEX audit_org_at_idx ON gps.audit_log (org_id, at DESC);
