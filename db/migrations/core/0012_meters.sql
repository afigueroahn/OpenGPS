-- Odometer and engine hours of each vehicle. The platform keeps them by adding up
-- the distance traveled and the engine-on time as positions
-- arrive; if the device reads the vehicle's own, those take precedence. They are used by
-- the diagnostics and maintenance modules.
CREATE TABLE gps.vehicle_meters (
  vehicle_id    uuid PRIMARY KEY REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- What the platform has added up: meters traveled and seconds with the engine on.
  gps_m         double precision NOT NULL DEFAULT 0,
  engine_s      double precision NOT NULL DEFAULT 0,
  -- Last position counted, to continue from there.
  last_t        timestamptz,
  last_lat      double precision,
  last_lon      double precision,
  last_speed    real,
  last_ignition boolean,
  -- The latest the device read from the vehicle, if it reads it: meters and seconds, and when.
  ecu_m         double precision,
  ecu_m_at      timestamptz,
  ecu_s         double precision,
  ecu_s_at      timestamptz,
  -- Manual adjustment: what is added to the current source so that it shows what
  -- the dashboard shows. Each adjustment remembers which source it was made with.
  odo_offset_m  double precision NOT NULL DEFAULT 0,
  odo_source    text NOT NULL DEFAULT 'gps' CHECK (odo_source IN ('gps', 'ecu')),
  hrs_offset_s  double precision NOT NULL DEFAULT 0,
  hrs_source    text NOT NULL DEFAULT 'ignition' CHECK (hrs_source IN ('ignition', 'ecu')),
  since         timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
