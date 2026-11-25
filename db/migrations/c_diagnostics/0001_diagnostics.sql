-- Module C · Diagnostics. Own tables: changes none of the core. The
-- values the device reads from the vehicle are not copied here: they come from the
-- positions when queried.

-- Account notification limits. Null: that notification is off.
CREATE TABLE gps.diag_settings (
  org_id         text PRIMARY KEY REFERENCES auth.organization (id) ON DELETE CASCADE,
  rpm_max        integer,
  temp_max_c     real,
  voltage_min_v  real,
  zone           text NOT NULL DEFAULT 'UTC'
);

-- Limits specific to a vehicle: only those that differ from the account's.
CREATE TABLE gps.diag_limits (
  vehicle_id  uuid PRIMARY KEY REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  limits      jsonb NOT NULL
);

-- Fault codes each vehicle has reported, and from when to when.
CREATE TABLE gps.vehicle_faults (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  code        text NOT NULL,
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  cleared_at  timestamptz
);
-- A code is active only once per vehicle.
CREATE UNIQUE INDEX vehicle_faults_active ON gps.vehicle_faults (vehicle_id, code) WHERE cleared_at IS NULL;
CREATE INDEX vehicle_faults_vehicle ON gps.vehicle_faults (vehicle_id, first_seen DESC);
