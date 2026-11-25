-- Alerts: rules that detect a situation (speeding, signal loss,
-- a device alarm…) and decide how notifications are sent.
CREATE TABLE gps.alert_rules (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  type         text NOT NULL,
  -- What is specific to each type: speed limit, minutes without signal, conditions.
  params       jsonb NOT NULL DEFAULT '{}',
  -- Days and hours when the alert is active; NULL = always.
  schedule     jsonb,
  -- Which vehicles it applies to: some vehicles, some groups or, with both NULL, all.
  vehicle_ids  uuid[],
  group_ids    uuid[],
  -- Time zone of its creator, to write times in the emails.
  zone         text NOT NULL DEFAULT 'UTC',
  active       boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_rules_org ON gps.alert_rules (org_id);

-- What each alert remembers about each device: since when the
-- condition has held and when it last notified.
CREATE TABLE gps.alert_state (
  rule_id     uuid NOT NULL REFERENCES gps.alert_rules (id) ON DELETE CASCADE,
  device_id   bigint NOT NULL REFERENCES gps.devices (id) ON DELETE CASCADE,
  since       timestamptz,
  alerted_at  timestamptz,
  data        jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (rule_id, device_id)
);
CREATE INDEX alert_state_device ON gps.alert_state (device_id);

ALTER TABLE gps.events ADD COLUMN rule_id uuid REFERENCES gps.alert_rules (id) ON DELETE SET NULL;

-- Parked mode: the owner leaves the vehicle and wants to know if it moves.
ALTER TABLE gps.vehicles
  ADD COLUMN parked_since timestamptz,
  ADD COLUMN parked_lat   double precision,
  ADD COLUMN parked_lon   double precision;

-- The basic alerts (panic, battery, tow, parked) are created automatically
-- the first time; afterwards the account can change or delete them.
ALTER TABLE gps.account_settings ADD COLUMN alerts_seeded boolean NOT NULL DEFAULT false;
