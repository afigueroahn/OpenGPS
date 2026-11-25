-- Module H · Routes and logistics: points of interest, planned routes and
-- dispatches with their stops and proof of delivery.

-- Places the account visits: customers, warehouses, branches.
CREATE TABLE gps.pois (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  category    text NOT NULL DEFAULT 'other' CHECK (category IN ('client', 'warehouse', 'branch', 'fuel', 'workshop', 'parking', 'other')),
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  -- How close a vehicle must be to be considered at the place.
  radius_m    integer NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 20 AND 2000),
  address     text,
  phone       text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pois_org ON gps.pois (org_id);

-- A planned route: where it goes (the line), how far a vehicle may stray from it
-- and at which places it stops. It serves as a template for dispatches.
CREATE TABLE gps.route_plans (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Points [lon, lat] of the path; empty if the route is just a list of stops.
  line         jsonb NOT NULL DEFAULT '[]',
  tolerance_m  integer NOT NULL DEFAULT 150 CHECK (tolerance_m BETWEEN 30 AND 2000),
  -- Stops in order: name, place, minutes from departure and dwell time.
  stops        jsonb NOT NULL DEFAULT '[]',
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX route_plans_org ON gps.route_plans (org_id);

-- A dispatch: some stops assigned to a vehicle for a date and time.
CREATE TABLE gps.route_trips (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  plan_id       uuid REFERENCES gps.route_plans (id) ON DELETE SET NULL,
  name          text NOT NULL,
  vehicle_id    uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  driver        text,
  starts_at     timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'in_progress', 'done', 'cancelled')),
  line          jsonb NOT NULL DEFAULT '[]',
  tolerance_m   integer NOT NULL DEFAULT 150,
  -- Whether it is currently outside its route's corridor.
  off_route     boolean NOT NULL DEFAULT false,
  started_at    timestamptz,
  finished_at   timestamptz,
  -- Driver link: its hash is stored, not the key.
  driver_token  text UNIQUE,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX route_trips_org ON gps.route_trips (org_id, starts_at DESC);
CREATE INDEX route_trips_active ON gps.route_trips (vehicle_id) WHERE status IN ('assigned', 'in_progress');

CREATE TABLE gps.route_trip_stops (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  trip_id         uuid NOT NULL REFERENCES gps.route_trips (id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  name            text NOT NULL,
  lat             double precision NOT NULL,
  lon             double precision NOT NULL,
  radius_m        integer NOT NULL DEFAULT 100,
  planned_at      timestamptz,
  -- Who it is delivered to, to notify them.
  contact         text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'arrived', 'done', 'failed', 'skipped')),
  arrived_at      timestamptz,
  done_at         timestamptz,
  -- Proof of delivery: who received it, a note, and the photo and signature on the server's disk.
  recipient       text,
  note            text,
  photo_mime      text,
  signature_mime  text,
  -- Public tracking link for this delivery: its hash.
  track_token     text UNIQUE
);
CREATE INDEX route_trip_stops_trip ON gps.route_trip_stops (trip_id, seq);
