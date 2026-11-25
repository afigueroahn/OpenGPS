-- Module B · Driver. Own tables: changes none of the core.

CREATE TABLE gps.drivers (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  license     text,
  phone       text,
  -- Identification key (iButton or card), uppercase and without leading zeros.
  key_id      text,
  notes       text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drivers_org ON gps.drivers (org_id);
CREATE UNIQUE INDEX drivers_key ON gps.drivers (org_id, key_id) WHERE key_id IS NOT NULL;

-- Who drove each vehicle and when. A vehicle has at most one
-- driver at a time, and a driver at most one vehicle.
CREATE TABLE gps.driver_assignments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  driver_id   uuid NOT NULL REFERENCES gps.drivers (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  -- 'manual' was assigned by a person; 'key' was identified by their key on the device.
  source      text NOT NULL CHECK (source IN ('manual', 'key')),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE UNIQUE INDEX driver_assignments_vehicle_now ON gps.driver_assignments (vehicle_id) WHERE ends_at IS NULL;
CREATE UNIQUE INDEX driver_assignments_driver_now ON gps.driver_assignments (driver_id) WHERE ends_at IS NULL;
CREATE INDEX driver_assignments_vehicle ON gps.driver_assignments (vehicle_id, starts_at);
CREATE INDEX driver_assignments_driver ON gps.driver_assignments (driver_id, starts_at);

-- What takes points off: hard accelerations, hard braking, sharp turns and speeding.
CREATE TABLE gps.driver_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  -- Whoever was driving at that moment; null if the vehicle had no driver.
  driver_id   uuid REFERENCES gps.drivers (id) ON DELETE SET NULL,
  type        text NOT NULL CHECK (type IN ('accel', 'brake', 'corner', 'speeding')),
  at          timestamptz NOT NULL,
  lat         double precision,
  lon         double precision,
  speed_kmh   real,
  detail      jsonb NOT NULL DEFAULT '{}'
);
-- The same notification received twice does not count double.
CREATE UNIQUE INDEX driver_events_once ON gps.driver_events (vehicle_id, type, at);
CREATE INDEX driver_events_org ON gps.driver_events (org_id, at);
CREATE INDEX driver_events_driver ON gps.driver_events (driver_id, at);

CREATE TABLE gps.driver_settings (
  org_id              text PRIMARY KEY REFERENCES auth.organization (id) ON DELETE CASCADE,
  speed_limit_kmh     integer NOT NULL,
  speeding_seconds    integer NOT NULL,
  max_continuous_min  integer NOT NULL,
  min_rest_min        integer NOT NULL,
  max_daily_min       integer NOT NULL
);

-- Live tracking of each vehicle: speeding in progress, stretch of
-- driving without rest and shift.
CREATE TABLE gps.driving_state (
  vehicle_id        uuid PRIMARY KEY REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  last_t            timestamptz NOT NULL,
  last_moving       timestamptz,
  stretch_s         integer NOT NULL DEFAULT 0,
  stretch_warned    boolean NOT NULL DEFAULT false,
  shift_s           integer NOT NULL DEFAULT 0,
  shift_warned      boolean NOT NULL DEFAULT false,
  over_since        timestamptz,
  over_max          real,
  over_event_id     bigint,
  unknown_key       text,
  unknown_key_at    timestamptz
);
