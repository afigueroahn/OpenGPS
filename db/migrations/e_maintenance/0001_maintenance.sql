-- Module E · Maintenance: service plans by mileage, hours or date,
-- work orders with their costs, workshops, parts and expiries.

CREATE TABLE gps.maint_settings (
  org_id    text PRIMARY KEY REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- Currency proposed when recording a cost.
  currency  text NOT NULL DEFAULT 'HNL' CHECK (currency ~ '^[A-Z]{3}$'),
  zone      text NOT NULL DEFAULT 'UTC'
);

-- Workshops where work is done and part suppliers.
CREATE TABLE gps.maint_workshops (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'workshop' CHECK (kind IN ('workshop', 'supplier')),
  contact     text,
  phone       text,
  email       text,
  address     text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX maint_workshops_name ON gps.maint_workshops (org_id, lower(name));

CREATE TABLE gps.maint_parts (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text,
  unit        text NOT NULL DEFAULT 'unidad',
  -- Reference cost: proposed when using the part in an order.
  unit_cost   numeric(14, 2),
  -- Stock, if the account tracks it: decreases when an order that uses the part is completed.
  stock       numeric(12, 2),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX maint_parts_name ON gps.maint_parts (org_id, lower(name));

-- A plan says how often a service is due: by kilometers, by engine hours
-- or by time; whichever comes first. And how far in advance to notify.
CREATE TABLE gps.maint_plans (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name         text NOT NULL,
  every_km     integer CHECK (every_km > 0),
  every_hours  integer CHECK (every_hours > 0),
  every_days   integer CHECK (every_days > 0),
  warn_km      integer CHECK (warn_km >= 0),
  warn_hours   integer CHECK (warn_hours >= 0),
  warn_days    integer CHECK (warn_days >= 0),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (every_km IS NOT NULL OR every_hours IS NOT NULL OR every_days IS NOT NULL)
);
CREATE INDEX maint_plans_org ON gps.maint_plans (org_id);

-- The plan applied to a vehicle: when the service was last done.
CREATE TABLE gps.maint_schedules (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES gps.maint_plans (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  last_on     date NOT NULL,
  last_km     real,
  last_hours  real,
  UNIQUE (plan_id, vehicle_id)
);
CREATE INDEX maint_schedules_vehicle ON gps.maint_schedules (vehicle_id);

CREATE TABLE gps.maint_orders (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  -- Sequential number within the account.
  number        integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('preventive', 'corrective')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  title         text NOT NULL,
  description   text,
  -- The scheduled service this order fulfills: when it is completed, its count starts over.
  schedule_id   uuid REFERENCES gps.maint_schedules (id) ON DELETE SET NULL,
  workshop_id   uuid REFERENCES gps.maint_workshops (id) ON DELETE SET NULL,
  opened_on     date NOT NULL,
  done_on       date,
  odometer_km   real,
  engine_hours  real,
  labor_cost    numeric(14, 2) NOT NULL DEFAULT 0 CHECK (labor_cost >= 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX maint_orders_vehicle ON gps.maint_orders (vehicle_id, opened_on DESC);

-- Parts and materials used in an order. The name is stored with the line:
-- it stays understandable if the part is deleted from the catalog.
CREATE TABLE gps.maint_order_parts (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  order_id   uuid NOT NULL REFERENCES gps.maint_orders (id) ON DELETE CASCADE,
  part_id    uuid REFERENCES gps.maint_parts (id) ON DELETE SET NULL,
  name       text NOT NULL,
  quantity   numeric(12, 2) NOT NULL CHECK (quantity > 0),
  unit_cost  numeric(14, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);
CREATE INDEX maint_order_parts_order ON gps.maint_order_parts (order_id);

-- Attachments of an order: the invoice, photos of the work. The file goes to the server's disk.
CREATE TABLE gps.maint_order_files (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  order_id     uuid NOT NULL REFERENCES gps.maint_orders (id) ON DELETE CASCADE,
  name         text NOT NULL,
  mime         text NOT NULL,
  size         integer NOT NULL,
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maint_order_files_order ON gps.maint_order_files (order_id);

-- Expiries being watched: insurance, technical inspection, registration, license.
CREATE TABLE gps.maint_expiries (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('insurance', 'inspection', 'registration', 'license', 'permit', 'other')),
  name        text,
  expires_on  date NOT NULL,
  warn_days   integer NOT NULL DEFAULT 30 CHECK (warn_days >= 0),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maint_expiries_vehicle ON gps.maint_expiries (vehicle_id);

-- Notifications already given, so as not to repeat them. `target` says which expiry
-- the notification refers to: when it changes (the service was done, the
-- document was renewed), it notifies again when the time comes.
CREATE TABLE gps.maint_notices (
  kind    text NOT NULL CHECK (kind IN ('schedule', 'expiry', 'document')),
  ref     uuid NOT NULL,
  org_id  text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  stage   text NOT NULL CHECK (stage IN ('soon', 'due')),
  target  text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref)
);
