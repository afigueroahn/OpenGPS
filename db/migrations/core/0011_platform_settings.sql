-- Platform settings defined in the admin console, by section
-- (general, passwords, email, storage, backups). What is not here
-- takes the value given by the server variables. Keys are stored encrypted.
CREATE TABLE gps.platform_settings (
  section     text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Backups made by the platform: both databases and the files
-- users upload. Each row says where it ended up and which files make it up.
CREATE TABLE gps.backups (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  kind          text NOT NULL CHECK (kind IN ('scheduled', 'manual', 'imported')),
  status        text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  error         text,
  -- [{ name, part, bytes }]
  files         jsonb NOT NULL DEFAULT '[]',
  bytes         bigint NOT NULL DEFAULT 0,
  -- It is on the server, in external storage, or in both.
  local         boolean NOT NULL DEFAULT false,
  remote        boolean NOT NULL DEFAULT false,
  remote_error  text,
  -- Folder in external storage where its files ended up.
  remote_prefix text,
  created_by    text
);
CREATE INDEX backups_started ON gps.backups (started_at DESC);
