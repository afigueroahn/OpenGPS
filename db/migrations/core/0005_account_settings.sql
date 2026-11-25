-- Platform administration: account suspension, quotas and modules.
-- An account with no row here is active, with no quotas and no optional modules.
CREATE TABLE gps.account_settings (
  org_id            text PRIMARY KEY REFERENCES auth.organization (id) ON DELETE CASCADE,
  suspended         boolean NOT NULL DEFAULT false,
  suspended_reason  text,
  -- Quotas: NULL = no limit.
  max_vehicles      integer CHECK (max_vehicles IS NULL OR max_vehicles >= 0),
  max_users         integer CHECK (max_users IS NULL OR max_users >= 1),
  -- Enabled optional modules (letters A to I of the plan).
  modules           text[] NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);
