-- Temporary links to share a vehicle's location with someone
-- outside the account. Only the link's hash is stored: whoever reads the
-- database (or a backup) cannot reconstruct a live link.
CREATE TABLE gps.share_links (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  vehicle_id      uuid NOT NULL REFERENCES gps.vehicles (id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  -- Who it is for, in the creator's words. Only visible within the account.
  note            text NOT NULL DEFAULT '' CHECK (length(note) <= 60),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  views           integer NOT NULL DEFAULT 0,
  last_viewed_at  timestamptz
);
CREATE INDEX share_links_vehicle ON gps.share_links (vehicle_id);
