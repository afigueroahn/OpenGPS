-- Users of an account: roles, group scope, invitations and immutable
-- audit log. Account membership lives in auth.member; this holds what
-- each member can do and see.

-- ─── Custom roles ────────────────────────────────────────────────────────────
CREATE TABLE gps.roles (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  name         text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_name_idx ON gps.roles (org_id, lower(name));

-- ─── Access of each member ───────────────────────────────────────────────────
-- role: 'admin', 'operator', 'viewer' or the id of a role in gps.roles.
-- group_scope: groups they can see; NULL = all, empty = none.
CREATE TABLE gps.member_access (
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'viewer',
  group_scope  uuid[],
  disabled     boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- Access granted to whoever accepts an invitation.
CREATE TABLE gps.invitation_access (
  invitation_id  text PRIMARY KEY REFERENCES auth.invitation (id) ON DELETE CASCADE,
  org_id         text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  role           text NOT NULL,
  group_scope    uuid[]
);

-- Last account each person used, to open it when they sign in.
CREATE TABLE gps.user_settings (
  user_id      text PRIMARY KEY REFERENCES auth."user" (id) ON DELETE CASCADE,
  last_org_id  text
);

-- ─── Immutable audit log ─────────────────────────────────────────────────────
-- No one can change or delete a row of the log. The only exception is
-- a purge declared within its transaction (retention or account deletion).
CREATE FUNCTION gps.audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('gps.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'The audit log cannot be changed';
END $$;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON gps.audit_log
  FOR EACH ROW EXECUTE FUNCTION gps.audit_log_guard();

CREATE INDEX audit_at_idx ON gps.audit_log (org_id, id DESC);
