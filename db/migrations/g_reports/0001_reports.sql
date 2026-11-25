-- Module G · Reports and dashboards. Reports are calculated when requested; here
-- only what the account configures is stored: scheduled reports and dashboards.

-- Scheduled report: a report that is generated automatically and arrives by email.
CREATE TABLE gps.report_schedules (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- Who scheduled it. The report contains what that person can see at that moment.
  created_by   text NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  type         text NOT NULL,
  -- Which vehicles and with which options.
  params       jsonb NOT NULL DEFAULT '{}',
  frequency    text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  -- Send time in minutes since midnight in `zone`; day of the week
  -- (0 = Sunday) for weekly ones and day of the month for monthly ones.
  at_minute    smallint NOT NULL CHECK (at_minute BETWEEN 0 AND 1439),
  weekday      smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  month_day    smallint NOT NULL DEFAULT 1 CHECK (month_day BETWEEN 1 AND 28),
  zone         text NOT NULL,
  format       text NOT NULL CHECK (format IN ('xlsx', 'pdf')),
  -- People in the account who receive it.
  recipients   text[] NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  next_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_schedules_org ON gps.report_schedules (org_id);
CREATE INDEX report_schedules_due ON gps.report_schedules (next_run_at) WHERE active;

-- Each delivery of a scheduled report, with its result.
CREATE TABLE gps.report_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id  uuid NOT NULL REFERENCES gps.report_schedules (id) ON DELETE CASCADE,
  org_id       text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  period_from  timestamptz NOT NULL,
  period_to    timestamptz NOT NULL,
  ok           boolean NOT NULL,
  error        text,
  -- How many people it reached.
  sent_to      integer NOT NULL DEFAULT 0,
  -- Someone requested it with "Send now", outside its schedule.
  manual       boolean NOT NULL DEFAULT false
);
CREATE INDEX report_runs_schedule ON gps.report_runs (schedule_id, id DESC);

-- Indicator dashboards. Each person builds their own in each account.
CREATE TABLE gps.dashboards (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      text NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  period      text NOT NULL,
  group_id    uuid REFERENCES gps.vehicle_groups (id) ON DELETE SET NULL,
  -- Indicators it shows, in order.
  widgets     text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboards_owner ON gps.dashboards (org_id, user_id, created_at);
