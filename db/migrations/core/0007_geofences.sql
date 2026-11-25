-- Geofences, the membership of each device in each one and the events that come
-- from it (entries, exits, dwell times and route deviations).
CREATE TABLE gps.geofences (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  shape       text NOT NULL CHECK (shape IN ('circle', 'polygon', 'corridor')),
  -- Circle: center and radius. Polygon: its points. Corridor: the line and its width.
  geometry    jsonb NOT NULL,
  -- Box that contains it with a margin, to quickly discard distant positions.
  min_lat     double precision NOT NULL,
  max_lat     double precision NOT NULL,
  min_lon     double precision NOT NULL,
  max_lon     double precision NOT NULL,
  kind        text NOT NULL DEFAULT 'notify' CHECK (kind IN ('notify', 'forbidden', 'authorized')),
  -- Days and hours when the rule applies; NULL = always.
  schedule    jsonb,
  -- Minimum and maximum dwell time, in seconds; NULL = no control.
  min_stay_s  integer CHECK (min_stay_s IS NULL OR min_stay_s > 0),
  max_stay_s  integer CHECK (max_stay_s IS NULL OR max_stay_s > 0),
  -- Vehicle groups it applies to; NULL = all in the account.
  group_ids   uuid[],
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX geofences_org ON gps.geofences (org_id);

-- Whether each device is inside or outside each geofence, and since when.
CREATE TABLE gps.geofence_state (
  geofence_id  uuid NOT NULL REFERENCES gps.geofences (id) ON DELETE CASCADE,
  device_id    bigint NOT NULL REFERENCES gps.devices (id) ON DELETE CASCADE,
  inside       boolean NOT NULL,
  since        timestamptz NOT NULL,
  -- Last notification of each type, so as not to repeat it in the same stay or schedule.
  alerted      jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (geofence_id, device_id)
);
CREATE INDEX geofence_state_device ON gps.geofence_state (device_id);

-- Up to which position of each device the rules have been checked. Data that
-- arrives late does not trigger notifications for the past.
CREATE TABLE gps.event_watch (
  device_id  bigint PRIMARY KEY REFERENCES gps.devices (id) ON DELETE CASCADE,
  last_fix   timestamptz NOT NULL
);

-- Events. They keep the geofence name so they stay understandable if
-- it is deleted. They go with the device, like its position history.
CREATE TABLE gps.events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id   uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  device_id    bigint NOT NULL REFERENCES gps.devices (id) ON DELETE CASCADE,
  type         text NOT NULL,
  at           timestamptz NOT NULL,
  geofence_id  uuid REFERENCES gps.geofences (id) ON DELETE SET NULL,
  lat          double precision,
  lon          double precision,
  speed_kmh    real,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_org_time ON gps.events (org_id, id DESC);
CREATE INDEX events_vehicle_time ON gps.events (vehicle_id, id DESC);
