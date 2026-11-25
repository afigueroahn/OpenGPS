-- Whoever administers the whole platform: the first person who signs up and
-- confirms their email becomes its owner.

CREATE TABLE gps.platform_owners (
  user_id text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
