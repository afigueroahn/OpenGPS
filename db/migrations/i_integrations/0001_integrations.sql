-- Module I · Integrations: public API keys, webhooks with their
-- delivery log, automations and sensors that send readings.

-- Keys with which another system queries the API. Its hash is stored, not the key.
CREATE TABLE gps.api_keys (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- Its first characters, to recognize it in the list.
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  -- Whether, besides reading, it can record things (a dispatch, a fill).
  can_write     boolean NOT NULL DEFAULT false,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_org ON gps.api_keys (org_id);

-- Where notifications are sent when something happens. The signing secret and the
-- custom headers (the other system's key) are stored encrypted.
CREATE TABLE gps.webhooks (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  url         text NOT NULL,
  secret      text NOT NULL,
  headers     text,
  -- Event types it is interested in; NULL = all.
  events      text[],
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_org ON gps.webhooks (org_id);

-- Their deliveries wait in the platform's outbox (gps.outbox), like every other message.

-- When something happens (trigger) on certain vehicles and hours (condition),
-- something is done (action): a notification through a channel, a call to another system, a work order.
CREATE TABLE gps.automations (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  triggers      text[] NOT NULL,
  -- If the group is deleted, the automation goes with it: it does not start applying to the whole account.
  group_id      uuid REFERENCES gps.vehicle_groups (id) ON DELETE CASCADE,
  vehicle_ids   uuid[],
  schedule      jsonb,
  -- Minutes it waits before acting again for the same vehicle.
  cooldown_min  integer NOT NULL DEFAULT 0 CHECK (cooldown_min >= 0),
  action        jsonb NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automations_org ON gps.automations (org_id);

CREATE TABLE gps.automation_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  automation_id  uuid NOT NULL REFERENCES gps.automations (id) ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  vehicle_id     uuid,
  vehicle_name   text,
  event_type     text NOT NULL,
  ok             boolean NOT NULL,
  detail         text
);
CREATE INDEX automation_runs_log ON gps.automation_runs (automation_id, id DESC);

-- A sensor that is not a GPS: a temperature probe, a door, a
-- scale. It sends its readings over HTTP with its own key.
CREATE TABLE gps.sensors (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'other' CHECK (kind IN ('temperature', 'humidity', 'door', 'level', 'weight', 'other')),
  unit        text,
  -- Vehicle it is on, if it is on one: its notifications come out as alerts of that vehicle.
  vehicle_id  uuid REFERENCES gps.vehicles (id) ON DELETE SET NULL,
  -- Outside this range, it notifies.
  min_value   double precision,
  max_value   double precision,
  key_prefix  text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  last_value  double precision,
  last_at     timestamptz,
  -- Whether its last reading was out of range: it notifies on leaving, not on every reading.
  alerting    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sensors_org ON gps.sensors (org_id);

CREATE TABLE gps.sensor_readings (
  sensor_id  uuid NOT NULL REFERENCES gps.sensors (id) ON DELETE CASCADE,
  at         timestamptz NOT NULL,
  value      double precision NOT NULL,
  PRIMARY KEY (sensor_id, at)
);
