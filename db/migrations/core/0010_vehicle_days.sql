-- Trips and stops of each vehicle, stored by day (UTC). They come from the
-- positions via the trip engine; they are stored so that a report spanning several
-- weeks does not have to reread them all. If a late position arrives, the day
-- is deleted and recalculated when requested.
CREATE TABLE gps.vehicle_days (
  vehicle_id   uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  day          date NOT NULL,
  -- Version of the rules it was calculated with; when they change, earlier data is invalid.
  version      smallint NOT NULL,
  data         jsonb NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, day)
);

-- Reports query the events of an account by date.
CREATE INDEX events_org_at ON gps.events (org_id, at);
