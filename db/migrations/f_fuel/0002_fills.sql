-- Module F · Fuel: fills, refuel and drain notifications, and
-- module settings on the account. Own tables: changes none of the core.

-- Recorded fills: by hand, imported from a file, or detected by
-- the sensor and confirmed by someone. Refuels seen only by the sensor are not
-- stored: they come from the positions when queried.
CREATE TABLE gps.fuel_fills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id   uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  at           timestamptz NOT NULL,
  liters       real NOT NULL CHECK (liters > 0),
  -- Total paid and in which currency (three-letter code).
  total        numeric(14, 2) CHECK (total >= 0),
  currency     text CHECK (currency ~ '^[A-Z]{3}$'),
  odometer_km  real,
  station      text,
  note         text,
  source       text NOT NULL CHECK (source IN ('manual', 'imported', 'detected')),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (total IS NULL OR currency IS NOT NULL)
);
-- The same fill is not recorded twice: importing a file again does not duplicate.
CREATE UNIQUE INDEX fuel_fills_once ON gps.fuel_fills (vehicle_id, at, liters);
CREATE INDEX fuel_fills_org ON gps.fuel_fills (org_id, at DESC);

-- Refuels and drains the module already recorded as an event, so as not to repeat them
-- when it looks at the same positions again.
CREATE TABLE gps.fuel_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('refuel', 'drain')),
  at          timestamptz NOT NULL,
  liters      real NOT NULL,
  engine_off  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fuel_events_vehicle ON gps.fuel_events (vehicle_id, kind, at DESC);

CREATE TABLE gps.fuel_settings (
  org_id       text PRIMARY KEY REFERENCES auth.organization (id) ON DELETE CASCADE,
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  zone         text NOT NULL DEFAULT 'UTC'
);
