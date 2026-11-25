-- Module A · Anti-theft and commands. Own tables: changes none of the core.

-- Immobilize and release orders for the ignition. An immobilize order waits
-- until it is safe to send, and expires if that moment never comes.
CREATE TABLE gps.commands (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  device_id     bigint NOT NULL REFERENCES gps.devices (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('lock', 'unlock')),
  status        text NOT NULL CHECK (status IN ('waiting', 'sent', 'confirmed', 'unconfirmed', 'failed', 'expired', 'cancelled')),
  requested_by  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  sent_at       timestamptz,
  finished_at   timestamptz,
  note          text
);
CREATE INDEX commands_vehicle ON gps.commands (vehicle_id, created_at DESC);
CREATE INDEX commands_open ON gps.commands (device_id) WHERE finished_at IS NULL;

-- Security state of each vehicle: last immobilization ordered and recovery mode.
CREATE TABLE gps.vehicle_security (
  vehicle_id         uuid PRIMARY KEY REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  lock_state         text CHECK (lock_state IN ('locked', 'unlocked')),
  lock_confirmed     boolean NOT NULL DEFAULT false,
  lock_changed_at    timestamptz,
  recovery_since     timestamptz,
  recovery_share_id  uuid REFERENCES gps.share_links (id) ON DELETE SET NULL
);

-- Incidents: what needs a person to handle and close it.
CREATE TABLE gps.incidents (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  priority      smallint NOT NULL CHECK (priority IN (1, 2)),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'attended', 'closed')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  attended_by   text,
  attended_at   timestamptz,
  closed_by     text,
  closed_at     timestamptz,
  resolution    text,
  escalation    smallint NOT NULL DEFAULT 0,
  lat           double precision,
  lon           double precision
);
CREATE INDEX incidents_org ON gps.incidents (org_id, opened_at DESC);
-- Only one live incident per vehicle: new alarms are added to its timeline.
CREATE UNIQUE INDEX incidents_one_open ON gps.incidents (vehicle_id) WHERE status <> 'closed';

-- Evidence files: photos and documents. The content lives on disk.
CREATE TABLE gps.incident_files (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  incident_id  uuid NOT NULL REFERENCES gps.incidents (id) ON DELETE CASCADE,
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name         text NOT NULL,
  mime         text NOT NULL,
  size         integer NOT NULL,
  uploaded_by  text,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

-- Timeline of each incident.
CREATE TABLE gps.incident_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES gps.incidents (id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  user_id      text,
  text         text NOT NULL,
  file_id      uuid REFERENCES gps.incident_files (id) ON DELETE SET NULL
);
CREATE INDEX incident_entries_incident ON gps.incident_entries (incident_id, id);
