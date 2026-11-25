-- Module D · Fleet. Own tables: changes none of the core.

-- Extended profile of each vehicle: its data, its availability, whether it is
-- active, and what is needed to calculate its useful life.
CREATE TABLE gps.fleet_vehicles (
  vehicle_id        uuid PRIMARY KEY REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  org_id            text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vin               text,
  brand             text,
  model             text,
  year              integer,
  color             text,
  kind              text,
  -- Availability that someone sets by hand. "On route" is not stored: it comes from whether the vehicle is moving.
  status            text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'workshop', 'out_of_service')),
  status_note       text,
  status_since      timestamptz NOT NULL DEFAULT now(),
  -- Active, temporarily suspended or permanently retired.
  state             text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'retired')),
  state_note        text,
  state_since       timestamptz NOT NULL DEFAULT now(),
  purchase_date     date,
  purchase_price    numeric(14, 2) CHECK (purchase_price >= 0),
  currency          text CHECK (currency ~ '^[A-Z]{3}$'),
  salvage_value     numeric(14, 2) CHECK (salvage_value >= 0),
  life_years        real CHECK (life_years > 0),
  purchase_odo_km   real CHECK (purchase_odo_km >= 0),
  notes             text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Each change of availability or of activation and retirement, with who made it.
CREATE TABLE gps.fleet_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  field       text NOT NULL CHECK (field IN ('status', 'state')),
  value       text NOT NULL,
  note        text,
  user_id     text,
  user_name   text
);
CREATE INDEX fleet_log_vehicle ON gps.fleet_log (vehicle_id, at DESC);

-- Who each vehicle was assigned to and between which dates, for accounts without
-- the driver module. With that module, the history comes from its tables.
CREATE TABLE gps.fleet_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  person      text NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date,
  note        text,
  created_by  text,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX fleet_assignments_vehicle ON gps.fleet_assignments (vehicle_id, starts_on DESC);

CREATE TABLE gps.fleet_expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  on_date     date NOT NULL,
  category    text NOT NULL CHECK (category IN ('fuel', 'maintenance', 'toll', 'fine', 'insurance', 'tax', 'parking', 'other')),
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note        text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_expenses_org ON gps.fleet_expenses (org_id, on_date DESC);
CREATE INDEX fleet_expenses_vehicle ON gps.fleet_expenses (vehicle_id, on_date DESC);

-- Documents and photos of each vehicle. The file goes to the server's
-- storage, with this identifier as its name.
CREATE TABLE gps.fleet_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id   uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('photo', 'registration', 'insurance', 'inspection', 'permit', 'invoice', 'other')),
  name         text NOT NULL,
  mime         text NOT NULL,
  size         integer NOT NULL,
  expires_on   date,
  note         text,
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_documents_vehicle ON gps.fleet_documents (vehicle_id, created_at DESC);
