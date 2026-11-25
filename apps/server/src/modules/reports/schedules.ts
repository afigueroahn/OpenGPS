// Scheduled reports: a report that is generated on its own, every day, every week or
// every month, and arrives by email as a file to the people of the account who are
// chosen. It carries what the person who scheduled it can see.
import {
  REPORT_INFO,
  type ReportFormat,
  type ReportFrequency,
  type ReportParams,
  type ReportSchedule,
  type ReportType,
  SCHEDULES_MAX,
  type reportScheduleSchema,
} from "@opengps/shared";
import type { z } from "zod";
import { type Tenant, chosenLanguage, resolveAccess } from "../../core/access";
import { audit } from "../../core/audit";
import { numberClock } from "../../core/export/format";
import { writeMail } from "../../core/mail-templates";
import type { HistoryRange } from "../../core/history";
import type { Actor } from "../../core/vehicles";
import type { Queryable } from "../../db";
import { AppError, badRequest, conflict, notFound, tooMany } from "../../errors";
import { type Say, render, say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";
import { buildReport, carsOf } from "./build";
import { renderReport, summaryLine } from "./render";

type ScheduleData = z.output<typeof reportScheduleSchema>;
type When = Pick<ReportSchedule, "frequency" | "atMinute" | "weekday" | "monthDay" | "zone">;

/** "Send now" is not repeated on the same report before this time. */
const MANUAL_EVERY_MS = 60_000;

// ─── When it is due and what period it covers ────────────────────────────────

/** Next send after `after`, in the report's time zone. */
export function nextRun(s: When, after: number): number {
  const clock = numberClock(s.zone);
  const p = clock.parts(after);
  if (s.frequency === "monthly") {
    const t = clock.at(p.year, p.month, s.monthDay, s.atMinute);
    return t > after ? t : clock.at(p.year, p.month + 1, s.monthDay, s.atMinute);
  }
  for (let i = 0; i <= 7; i++) {
    const t = clock.at(p.year, p.month, p.day + i, s.atMinute);
    if (t > after && (s.frequency === "daily" || clock.parts(t).weekday === s.weekday)) return t;
  }
  return clock.at(p.year, p.month, p.day + 1, s.atMinute);
}

/** Period covered by a send made at `at`: the previous day, seven days or month, in full. */
export function periodFor(s: Pick<When, "frequency" | "zone">, at: number): HistoryRange {
  const clock = numberClock(s.zone);
  const p = clock.parts(at);
  if (s.frequency === "monthly") return { from: new Date(clock.at(p.year, p.month - 1, 1)), to: new Date(clock.at(p.year, p.month, 1)) };
  const days = s.frequency === "weekly" ? 7 : 1;
  return { from: new Date(clock.at(p.year, p.month, p.day - days)), to: new Date(clock.at(p.year, p.month, p.day)) };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  org_id: string;
  created_by: string;
  created_by_name: string | null;
  name: string;
  type: ReportType;
  params: ReportParams;
  frequency: ReportFrequency;
  at_minute: number;
  weekday: number;
  month_day: number;
  zone: string;
  format: ReportFormat;
  recipients: string[];
  active: boolean;
  next_run_at: Date | null;
  last_at: Date | null;
  last_ok: boolean | null;
  last_error: string | null;
}

const COLUMNS = `s.id, s.org_id, s.created_by, u.name AS created_by_name, s.name, s.type, s.params, s.frequency, s.at_minute, s.weekday, s.month_day,
                 s.zone, s.format, s.recipients, s.active, s.next_run_at, r.ran_at AS last_at, r.ok AS last_ok, r.error AS last_error`;
const FROM = `gps.report_schedules s
              LEFT JOIN auth."user" u ON u.id = s.created_by
              LEFT JOIN LATERAL (SELECT ran_at, ok, error FROM gps.report_runs WHERE schedule_id = s.id ORDER BY id DESC LIMIT 1) r ON true`;

export interface Person {
  userId: string;
  name: string;
  email: string;
}

/** People of the account who can receive a report: with a verified email and not blocked. */
export async function people(db: Queryable, orgId: string): Promise<Person[]> {
  const r = await db.query<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email
       FROM auth.member m
       JOIN auth."user" u ON u.id = m."userId"
       LEFT JOIN gps.member_access a ON a.org_id = m."organizationId" AND a.user_id = u.id
      WHERE m."organizationId" = $1 AND u."emailVerified" AND NOT COALESCE(u.banned, false) AND NOT COALESCE(a.disabled, false)
      ORDER BY lower(u.name)`,
    [orgId],
  );
  return r.rows.map((u) => ({ userId: u.id, name: u.name, email: u.email }));
}

function toSchedule(row: Row, known: Map<string, Person>): ReportSchedule {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    params: row.params,
    frequency: row.frequency,
    atMinute: row.at_minute,
    weekday: row.weekday,
    monthDay: row.month_day,
    zone: row.zone,
    format: row.format,
    recipients: row.recipients.map((id) => known.get(id)).filter((p): p is Person => p !== undefined),
    active: row.active,
    nextRunAt: row.active ? (row.next_run_at?.toISOString() ?? null) : null,
    lastRun: row.last_at ? { at: row.last_at.toISOString(), ok: row.last_ok === true, error: row.last_error } : null,
    createdByName: row.created_by_name ?? "",
  };
}

/** Whoever sees all groups administers all reports; the rest, only their own. */
const ownOnly = (who: Tenant & { userId: string | null }) => (who.groups === null ? null : who.userId);

export async function listSchedules(db: Queryable, who: Tenant & { userId: string }): Promise<ReportSchedule[]> {
  const r = await db.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.org_id = $1 AND ($2::text IS NULL OR s.created_by = $2) ORDER BY s.created_at`, [who.orgId, ownOnly(who)]);
  const known = new Map((await people(db, who.orgId)).map((p) => [p.userId, p]));
  return r.rows.map((row) => toSchedule(row, known));
}

async function rowOf(db: Queryable, who: Tenant & { userId: string | null }, id: string): Promise<Row> {
  const r = await db.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = $1 AND s.org_id = $2 AND ($3::text IS NULL OR s.created_by = $3)`, [id, who.orgId, ownOnly(who)]);
  if (!r.rows[0]) throw notFound(say("reports.errors.scheduleNotFound"));
  return r.rows[0];
}

// ─── Creating and changing ───────────────────────────────────────────────────

const UUID = /^[0-9a-f-]{36}$/i;

async function check(deps: Pick<ModuleDeps, "db" | "gate">, actor: Actor, data: ScheduleData): Promise<void> {
  const requires = REPORT_INFO[data.type].requires;
  if (requires && !(await deps.gate.enabled(actor.orgId, requires))) throw badRequest(say("reports.errors.notAvailable"));
  const known = new Set((await people(deps.db.core, actor.orgId)).map((p) => p.userId));
  if (data.recipients.some((id) => !known.has(id))) throw badRequest(say("reports.errors.recipientsOutside"));
  // The chosen group or vehicles must be within reach of whoever schedules it.
  await carsOf(deps.db.core, actor, data.params);
}

export async function createSchedule(deps: Pick<ModuleDeps, "db" | "gate">, actor: Actor, data: ScheduleData, now = Date.now()): Promise<ReportSchedule> {
  if (!actor.userId) throw badRequest(say("reports.errors.sessionNeeded"));
  const db = deps.db.core;
  await check(deps, actor, data);
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gps.report_schedules WHERE org_id = $1`, [actor.orgId]);
  if ((count.rows[0]?.n ?? 0) >= SCHEDULES_MAX) throw conflict("schedules_limit", say("reports.errors.schedulesLimit", { max: SCHEDULES_MAX }));
  const r = await db.query<{ id: string }>(
    `INSERT INTO gps.report_schedules (org_id, created_by, name, type, params, frequency, at_minute, weekday, month_day, zone, format, recipients, active, next_run_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [actor.orgId, actor.userId, data.name, data.type, JSON.stringify(data.params), data.frequency, data.atMinute, data.weekday, data.monthDay, data.zone, data.format, data.recipients, data.active, data.active ? new Date(nextRun(data, now)) : null],
  );
  const id = (r.rows[0] as { id: string }).id;
  await audit(db, actor, "report.schedule.create", "report_schedule", id, { name: data.name, type: data.type, frequency: data.frequency, recipients: data.recipients.length });
  return toSchedule(await rowOf(db, { ...actor, groups: null }, id), new Map((await people(db, actor.orgId)).map((p) => [p.userId, p])));
}

export async function updateSchedule(deps: Pick<ModuleDeps, "db" | "gate">, actor: Actor, id: string, data: ScheduleData, now = Date.now()): Promise<ReportSchedule> {
  if (!UUID.test(id)) throw notFound(say("reports.errors.scheduleNotFound"));
  const db = deps.db.core;
  await rowOf(db, actor, id);
  await check(deps, actor, data);
  await db.query(
    `UPDATE gps.report_schedules
        SET name = $2, type = $3, params = $4::jsonb, frequency = $5, at_minute = $6, weekday = $7, month_day = $8, zone = $9, format = $10,
            recipients = $11, active = $12, next_run_at = $13, updated_at = now()
      WHERE id = $1`,
    [id, data.name, data.type, JSON.stringify(data.params), data.frequency, data.atMinute, data.weekday, data.monthDay, data.zone, data.format, data.recipients, data.active, data.active ? new Date(nextRun(data, now)) : null],
  );
  await audit(db, actor, "report.schedule.update", "report_schedule", id, { name: data.name, active: data.active });
  return toSchedule(await rowOf(db, actor, id), new Map((await people(db, actor.orgId)).map((p) => [p.userId, p])));
}

export async function deleteSchedule(deps: Pick<ModuleDeps, "db">, actor: Actor, id: string): Promise<void> {
  if (!UUID.test(id)) throw notFound(say("reports.errors.scheduleNotFound"));
  const row = await rowOf(deps.db.core, actor, id);
  await deps.db.core.query(`DELETE FROM gps.report_schedules WHERE id = $1`, [id]);
  await audit(deps.db.core, actor, "report.schedule.delete", "report_schedule", id, { name: row.name });
}

// ─── Sending ─────────────────────────────────────────────────────────────────

type SendDeps = Pick<ModuleDeps, "db" | "gate" | "mailer" | "config">;

/** Generates the report for the period that is due and sends it. Returns how many people it reached. */
async function send(deps: SendDeps, row: Row, at: number, manual: boolean): Promise<number> {
  const db = deps.db.core;
  const range = periodFor({ frequency: row.frequency, zone: row.zone }, at);
  // A scheduled report has no request: the report, its file and its email are written in the language of whoever scheduled it.
  const language = (await chosenLanguage(db, row.created_by)) ?? deps.config.defaultLanguage;
  let sent = 0;
  let problem: Say | string | null = null;
  try {
    // The report carries what the person who scheduled it can see today.
    const access = await resolveAccess(db, row.created_by, row.org_id, language);
    if (!access || access.orgId !== row.org_id) {
      await db.query(`UPDATE gps.report_schedules SET active = false, next_run_at = NULL WHERE id = $1`, [row.id]);
      throw badRequest(say("reports.errors.creatorGone"));
    }
    const everyone = new Map((await people(db, row.org_id)).map((p) => [p.userId, p]));
    const to = row.recipients.map((id) => everyone.get(id)).filter((p) => p !== undefined);
    if (to.length === 0) throw badRequest(say("reports.errors.noRecipients"));
    const doc = await buildReport(deps, { orgId: row.org_id, groups: access.groups, vehicles: access.vehicles }, { type: row.type, range, zone: row.zone, params: row.params, language, now: at });
    const file = await renderReport(doc, row.format, deps.config.appName, language);
    const summary = summaryLine(doc, language);
    const words = {
      app: deps.config.appName,
      schedule: row.name,
      headline: summary.split(".")[0] ?? summary,
      title: doc.title.toLowerCase(),
      summary,
      every: tr(language, `reports.mail.every.${row.frequency}`),
      who: row.created_by_name || tr(language, "reports.mail.someone"),
    };
    const message = {
      ...writeMail(deps.config.mailTemplates, "scheduledReport", language, words, `${deps.config.publicUrl}/reports`),
      attachments: [{ filename: file.filename, content: file.body, contentType: file.contentType }],
    };
    const results = await Promise.allSettled(to.map((p) => deps.mailer.send({ to: p.email, ...message })));
    sent = results.filter((x) => x.status === "fulfilled").length;
    if (sent === 0) throw new Error("The mail server did not accept the message");
  } catch (err) {
    problem = err instanceof AppError ? err.text : say("reports.errors.sendFailed");
    if (!(err instanceof AppError)) console.error(`[reports] schedule ${row.id} failed:`, (err as Error).message);
  }
  // What went wrong is kept already written: the list of scheduled reports shows it later.
  const error = problem === null ? null : render(language, problem); // i18n: stored text
  await db.query(`INSERT INTO gps.report_runs (schedule_id, org_id, period_from, period_to, ok, error, sent_to, manual) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    row.id,
    row.org_id,
    range.from,
    range.to,
    error === null,
    error,
    sent,
    manual,
  ]);
  if (problem !== null) throw badRequest(problem);
  return sent;
}

/** "Send now": the same report that would go out on its schedule, without waiting. */
export async function sendNow(deps: SendDeps, actor: Actor, id: string, now = Date.now()): Promise<{ sentTo: number; schedule: ReportSchedule }> {
  if (!UUID.test(id)) throw notFound(say("reports.errors.scheduleNotFound"));
  const db = deps.db.core;
  const row = await rowOf(db, actor, id);
  if (row.last_at && now - row.last_at.getTime() < MANUAL_EVERY_MS) throw tooMany(say("reports.errors.justSent"));
  const sentTo = await send(deps, row, now, true).finally(() => audit(db, actor, "report.schedule.send", "report_schedule", id, { name: row.name }));
  return { sentTo, schedule: toSchedule(await rowOf(db, actor, id), new Map((await people(db, actor.orgId)).map((p) => [p.userId, p]))) };
}

/** Sends the reports whose time has already come. Returns how many it attempted. */
export async function sendDue(deps: SendDeps, now = Date.now()): Promise<number> {
  const db = deps.db.core;
  const due = await db.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.active AND s.next_run_at <= $1 ORDER BY s.next_run_at LIMIT 20`, [new Date(now)]);
  let tried = 0;
  for (const row of due.rows) {
    // The next send is recorded first: if something fails midway, this one is not repeated.
    const when: When = { frequency: row.frequency, atMinute: row.at_minute, weekday: row.weekday, monthDay: row.month_day, zone: row.zone };
    const claimed = await db.query(`UPDATE gps.report_schedules SET next_run_at = $2 WHERE id = $1 AND next_run_at <= $3 AND active`, [row.id, new Date(nextRun(when, now)), new Date(now)]);
    if (claimed.rowCount === 0) continue;
    // With the module off or the account suspended, the report waits without being sent.
    if (!(await deps.gate.enabled(row.org_id, "G"))) continue;
    tried++;
    await send(deps, row, now, false).catch(() => {});
  }
  return tried;
}
