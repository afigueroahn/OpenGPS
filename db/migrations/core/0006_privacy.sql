-- Privacy: record that each person accepted the terms of use and the
-- privacy policy, and which version.
CREATE TABLE gps.consents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      text NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  version      text NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  ip           text,
  UNIQUE (user_id, version)
);
