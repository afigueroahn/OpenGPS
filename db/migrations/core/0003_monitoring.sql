-- Full monitoring: power and signal in the current state, vehicle groups
-- and address cache.

-- ─── Current state: power and signal ─────────────────────────────────────────
ALTER TABLE gps.device_state
  ADD COLUMN ignition_inferred boolean NOT NULL DEFAULT false,
  ADD COLUMN power_v      real,
  ADD COLUMN battery_v    real,
  ADD COLUMN battery_pct  real,
  ADD COLUMN satellites   smallint,
  ADD COLUMN signal_bars  smallint;

-- ─── Vehicle groups ──────────────────────────────────────────────────────────
CREATE TABLE gps.vehicle_groups (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicle_groups_name_idx ON gps.vehicle_groups (org_id, lower(name));

ALTER TABLE gps.vehicles
  ADD COLUMN group_id uuid REFERENCES gps.vehicle_groups (id) ON DELETE SET NULL;
CREATE INDEX vehicles_group_idx ON gps.vehicles (group_id) WHERE group_id IS NOT NULL;

-- ─── Address cache ───────────────────────────────────────────────────────────
-- One cell per ten-thousandth of a degree (about 11 m). A null `address` means
-- the service found nothing there.
CREATE TABLE gps.geocode_cache (
  lat_key     integer NOT NULL,
  lon_key     integer NOT NULL,
  address     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lat_key, lon_key)
);
