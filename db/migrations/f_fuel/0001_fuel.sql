-- Module F · Fuel. Own table: changes none of the core.

-- Tank of each vehicle: where the level comes from and which standard is used to estimate
-- consumption. The level and consumption are not stored: they are calculated from the positions.
CREATE TABLE gps.fuel_tanks (
  vehicle_id    uuid PRIMARY KEY REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  capacity_l    real NOT NULL CHECK (capacity_l > 0),
  -- Device data that carries the level; null if the vehicle has no sensor.
  attr          text,
  kind          text NOT NULL CHECK (kind IN ('percent', 'liters', 'raw')),
  -- Pairs [sensor value, liters], from lowest to highest.
  calibration   jsonb,
  -- Data with the counter of fuel used by the engine, and its unit.
  counter_attr  text,
  counter_unit  text NOT NULL DEFAULT 'l' CHECK (counter_unit IN ('l', 'dl', 'ml')),
  norm_l100km   real,
  norm_idle_lh  real,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
