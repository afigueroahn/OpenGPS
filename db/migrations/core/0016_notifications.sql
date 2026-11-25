-- Notifications by channel. The platform owner connects the channels once
-- (email, SMS through Twilio, a custom address of another system and, once
-- the mobile app exists, push); each account says whom to notify, about what
-- and through which channel; and the platform has its own notifications for
-- whoever runs it.

-- ─── Outbox ──────────────────────────────────────────────────────────────────
-- Every message that leaves the platform through a channel waits here, is
-- retried with growing spacing if it fails, and stays as the log of what was sent.
CREATE TABLE gps.outbox (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL: a message of the platform itself, not of an account.
  org_id      text REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- What produced it, to show its log: 'notification' (an account's), 'system'
  -- (the platform's), 'automation', 'webhook' (module I) or 'test'.
  source      text NOT NULL,
  source_id   uuid,
  channel     text NOT NULL,
  -- Where it goes: an address, a phone. Encrypted, because some are secrets in
  -- themselves (another system's address). `label` is what the log shows.
  target      text NOT NULL,
  label       text NOT NULL,
  topic       text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_code   integer,
  last_error  text,
  next_at     timestamptz NOT NULL,
  created_at  timestamptz NOT NULL,
  done_at     timestamptz
);
CREATE INDEX outbox_due ON gps.outbox (next_at) WHERE status = 'pending';
CREATE INDEX outbox_source ON gps.outbox (source, source_id, id DESC);
-- For the log of an account and for its caps per channel.
CREATE INDEX outbox_org ON gps.outbox (org_id, channel, created_at);

-- ─── Notifications of an account ─────────────────────────────────────────────
CREATE TABLE gps.notifications (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name         text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email', 'sms', 'webhook', 'push')),
  active       boolean NOT NULL DEFAULT true,
  -- To whom: everyone in the account, some roles, some people, and addresses
  -- written by hand. People only receive what is about vehicles they see.
  everyone     boolean NOT NULL DEFAULT false,
  roles        text[] NOT NULL DEFAULT '{}',
  user_ids     text[] NOT NULL DEFAULT '{}',
  -- Encrypted list of the addresses written by hand: emails and phones.
  addresses    text,
  -- About what: event types (NULL = every alert) and, optionally, only the
  -- events of certain alerts.
  events       text[],
  rule_ids     uuid[],
  -- Of which vehicles: certain ones, certain groups or, with neither, all.
  group_ids    uuid[],
  vehicle_ids  uuid[],
  -- Time zone the message writes its times in.
  zone         text NOT NULL DEFAULT 'UTC',
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org ON gps.notifications (org_id, created_at);

-- ─── Notifications of the platform ───────────────────────────────────────────
-- For whoever runs it: a backup that failed, a disk filling up, a channel that
-- stopped delivering. They go to an address: push has none.
CREATE TABLE gps.system_notifications (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('email', 'sms', 'webhook')),
  -- Encrypted, like the outbox's.
  target      text NOT NULL,
  label       text NOT NULL,
  events      text[] NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The phone a person receives SMS notifications on, with its country code.
ALTER TABLE gps.user_settings ADD COLUMN phone text;
