// Incidents: what a person must attend to and close. A serious alarm opens
// an incident; later ones from the same vehicle are added to its timeline.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Incident,
  type IncidentDetail,
  type IncidentEntry,
  type IncidentKind,
  type IncidentResolution,
  type Language,
  SOS_ESCALATION_MIN,
  type TextParams,
  UPLOAD_MAX_MB,
} from "@opengps/shared";
import { type Tenant, isUuid, scopeParam, scopeSql } from "../../core/access";
import { audit } from "../../core/audit";
import { type Actor, getVehicle } from "../../core/vehicles";
import { filesFolder } from "../../core/files";
import { writeMail } from "../../core/mail-templates";
import { type Queryable, withTransaction } from "../../db";
import { badRequest, notFound } from "../../errors";
import { type Say, knownLanguage, render, say, tr } from "../../i18n";
import type { ModuleDeps } from "../context";

/** The timeline of an incident and the notes of an order are stored already written: in the platform's language. */
export const storedText = (deps: Pick<ModuleDeps, "config">, text: Say | string): string => render(deps.config.defaultLanguage, text); // i18n: stored text

/** Those that indicate an attack in progress come first. */
const PRIORITY: Record<IncidentKind, 1 | 2> = { sos: 1, tampering: 1, jamming: 1, tow: 2, power_cut: 2, movement: 2, manual: 2 };
/** The same repeated alarm does not fill the timeline: one note every so often. */
const REPEAT_MS = 5 * 60_000;

export const EVIDENCE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
/** Cap on the size of a file, whatever the platform settings say. */
export const EVIDENCE_MAX_BYTES = UPLOAD_MAX_MB * 1024 * 1024;
const EVIDENCE_MAX_FILES = 30;

interface Row {
  id: string;
  vehicle_id: string;
  vehicle_name: string;
  kind: IncidentKind;
  priority: 1 | 2;
  status: Incident["status"];
  opened_at: Date;
  attended_by: string | null;
  attended_at: Date | null;
  closed_by: string | null;
  closed_at: Date | null;
  resolution: IncidentResolution | null;
  escalation: number;
  lat: number | null;
  lon: number | null;
}
const toIncident = (r: Row): Incident => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  vehicleName: r.vehicle_name,
  kind: r.kind,
  priority: r.priority,
  status: r.status,
  openedAt: r.opened_at.toISOString(),
  attendedBy: r.attended_by,
  attendedAt: r.attended_at?.toISOString() ?? null,
  closedBy: r.closed_by,
  closedAt: r.closed_at?.toISOString() ?? null,
  resolution: r.resolution,
  escalation: r.escalation,
  lat: r.lat,
  lon: r.lon,
});

const SELECT = `SELECT i.id, i.vehicle_id, v.name AS vehicle_name, i.kind, i.priority, i.status, i.opened_at,
         ua.name AS attended_by, i.attended_at, uc.name AS closed_by, i.closed_at, i.resolution, i.escalation, i.lat, i.lon
    FROM gps.incidents i
    JOIN gps.vehicles v ON v.id = i.vehicle_id
    LEFT JOIN auth."user" ua ON ua.id = i.attended_by
    LEFT JOIN auth."user" uc ON uc.id = i.closed_by
   WHERE i.org_id = $1 AND ${scopeSql(2)}`;

/** Incidents of the vehicles this person sees: live ones first and, among them, priority ones. */
export async function listIncidents(db: Queryable, tenant: Tenant, opts: { open: boolean; limit: number }): Promise<Incident[]> {
  const r = await db.query<Row>(
    `${SELECT} AND ($3::boolean IS FALSE OR i.status <> 'closed')
      ORDER BY (i.status = 'closed'), i.priority, (i.status = 'attended'), i.opened_at DESC
      LIMIT $4`,
    [tenant.orgId, scopeParam(tenant), opts.open, opts.limit],
  );
  return r.rows.map(toIncident);
}

export async function getIncident(db: Queryable, tenant: Tenant, id: string): Promise<IncidentDetail> {
  if (!isUuid(id)) throw notFound(say("antitheft.errors.incidentNotFound"));
  const r = await db.query<Row>(`${SELECT} AND i.id = $3`, [tenant.orgId, scopeParam(tenant), id]);
  const row = r.rows[0];
  if (!row) throw notFound(say("antitheft.errors.incidentNotFound"));
  const entries = await db.query<{
    id: number;
    at: Date;
    kind: IncidentEntry["kind"];
    user_name: string | null;
    text: string;
    file_id: string | null;
    file_name: string | null;
    file_size: number | null;
    file_mime: string | null;
  }>(
    `SELECT e.id, e.at, e.kind, u.name AS user_name, e.text, f.id AS file_id, f.name AS file_name, f.size AS file_size, f.mime AS file_mime
       FROM gps.incident_entries e
       LEFT JOIN auth."user" u ON u.id = e.user_id
       LEFT JOIN gps.incident_files f ON f.id = e.file_id
      WHERE e.incident_id = $1
      ORDER BY e.id`,
    [id],
  );
  return {
    ...toIncident(row),
    entries: entries.rows.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      kind: e.kind,
      userName: e.user_name,
      text: e.text,
      file: e.file_id ? { id: e.file_id, name: e.file_name as string, size: e.file_size as number, mime: e.file_mime as string } : null,
    })),
  };
}

async function addEntry(db: Queryable, incidentId: string, kind: IncidentEntry["kind"], text: string, opts: { userId?: string | null; at?: Date; fileId?: string } = {}): Promise<void> {
  await db.query(`INSERT INTO gps.incident_entries (incident_id, kind, user_id, text, file_id, at) VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))`, [
    incidentId,
    kind,
    opts.userId ?? null,
    text,
    opts.fileId ?? null,
    opts.at ?? null,
  ]);
}

/** Owner and administrators of the account: they are written to when something is urgent. */
async function managers(db: Queryable, orgId: string): Promise<{ email: string; language: string | null }[]> {
  const r = await db.query<{ email: string; language: string | null }>(
    `SELECT u.email, us.language FROM auth.member m JOIN auth."user" u ON u.id = m."userId"
       LEFT JOIN gps.member_access a ON a.org_id = m."organizationId" AND a.user_id = u.id
       LEFT JOIN gps.user_settings us ON us.user_id = u.id
      WHERE m."organizationId" = $1 AND m.role IN ('owner', 'admin') AND u."emailVerified"
        AND NOT COALESCE(u.banned, false) AND NOT COALESCE(a.disabled, false)`,
    [orgId],
  );
  return r.rows;
}

/** Writes one of the panic emails to each of them, in the language they read. `words` fills its variables in that language. */
async function mailManagers(deps: ModuleDeps, orgId: string, template: "panic" | "panicUnattended", words: (language: Language) => TextParams): Promise<void> {
  const to = await managers(deps.db.core, orgId);
  await Promise.all(
    to.map(({ email: address, language: chosen }) => {
      const language = knownLanguage(chosen) ?? deps.config.defaultLanguage;
      return deps.mailer
        .send({ to: address, ...writeMail(deps.config.mailTemplates, template, language, { app: deps.config.appName, ...words(language) }, deps.config.publicUrl) })
        .catch((err: Error) => console.error(`[incidents] could not write to ${address}:`, err.message));
    }),
  );
}

/**
 * A serious alarm. Opens an incident for the vehicle or, if it already has
 * a live one, adds it to its timeline. Returns the incident.
 */
export async function raise(
  deps: ModuleDeps,
  vehicle: { orgId: string; vehicleId: string; groupId: string | null },
  kind: IncidentKind,
  opts: { at: number; lat: number | null; lon: number | null; text?: Say | string; userId?: string | null },
): Promise<{ id: string; opened: boolean }> {
  const text = storedText(deps, opts.text ?? say(`shared.incidentKind.${kind}`));
  const at = new Date(opts.at);
  const result = await withTransaction(deps.db.core, async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO gps.incidents (org_id, vehicle_id, kind, priority, opened_at, lat, lon)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (vehicle_id) WHERE status <> 'closed' DO NOTHING
       RETURNING id`,
      [vehicle.orgId, vehicle.vehicleId, kind, PRIORITY[kind], at, opts.lat, opts.lon],
    );
    if (created.rows[0]) {
      await addEntry(client, created.rows[0].id, kind === "manual" ? "note" : "alarm", text, { at, userId: opts.userId ?? null });
      return { id: created.rows[0].id, opened: true, escalated: false };
    }
    const live = await client.query<{ id: string; priority: number; kind: IncidentKind }>(
      `SELECT id, priority, kind FROM gps.incidents WHERE vehicle_id = $1 AND status <> 'closed' FOR UPDATE`,
      [vehicle.vehicleId],
    );
    const incident = live.rows[0] as { id: string; priority: number; kind: IncidentKind };
    const repeated = await client.query(`SELECT 1 FROM gps.incident_entries WHERE incident_id = $1 AND kind = 'alarm' AND text = $2 AND at > $3::timestamptz - make_interval(secs => $4)`, [
      incident.id,
      text,
      at,
      REPEAT_MS / 1000,
    ]);
    if (repeated.rowCount === 0) await addEntry(client, incident.id, kind === "manual" ? "note" : "alarm", text, { at, userId: opts.userId ?? null });
    // If something more serious than what opened the incident arrives, it raises the priority and the name.
    const upgraded = PRIORITY[kind] < incident.priority || (kind === "sos" && incident.kind !== "sos");
    if (upgraded) await client.query(`UPDATE gps.incidents SET priority = $2, kind = $3 WHERE id = $1`, [incident.id, PRIORITY[kind], kind]);
    return { id: incident.id, opened: false, escalated: upgraded };
  });
  deps.bus.emit("incident", { orgId: vehicle.orgId, groupId: vehicle.groupId, vehicleId: vehicle.vehicleId });
  // The panic button is notified by email right away to those who administer the account.
  if (kind === "sos" && (result.opened || result.escalated)) {
    const name = await deps.db.core.query<{ name: string }>(`SELECT name FROM gps.vehicles WHERE id = $1`, [vehicle.vehicleId]);
    void mailManagers(deps, vehicle.orgId, "panic", (language) => ({ vehicle: name.rows[0]?.name ?? tr(language, "antitheft.mail.vehicle") }));
  }
  return { id: result.id, opened: result.opened };
}

/** Notes something on the vehicle's live incident, if it has one. */
export async function annotate(
  deps: ModuleDeps,
  vehicle: { orgId: string; vehicleId: string; groupId: string | null },
  kind: IncidentEntry["kind"],
  text: Say | string,
  userId: string | null = null,
): Promise<void> {
  const live = await deps.db.core.query<{ id: string }>(`SELECT id FROM gps.incidents WHERE vehicle_id = $1 AND status <> 'closed'`, [vehicle.vehicleId]);
  if (!live.rows[0]) return;
  await addEntry(deps.db.core, live.rows[0].id, kind, storedText(deps, text), { userId });
  deps.bus.emit("incident", { orgId: vehicle.orgId, groupId: vehicle.groupId, vehicleId: vehicle.vehicleId });
}

/** A person reports something the device did not detect: a theft reported by phone, for example. */
export async function reportIncident(deps: ModuleDeps, actor: Actor, vehicleId: string, note: string): Promise<IncidentDetail> {
  const vehicle = await getVehicle(deps.db.core, actor, vehicleId);
  const { id } = await raise(deps, { orgId: actor.orgId, vehicleId, groupId: vehicle.groupId }, "manual", {
    at: Date.now(),
    lat: vehicle.state?.lat ?? null,
    lon: vehicle.state?.lon ?? null,
    text: note,
    userId: actor.userId,
  });
  await audit(deps.db.core, actor, "incident.report", "incident", id, { name: vehicle.name });
  return getIncident(deps.db.core, actor, id);
}

async function groupOf(db: Queryable, vehicleId: string): Promise<string | null> {
  const r = await db.query<{ group_id: string | null }>(`SELECT group_id FROM gps.vehicles WHERE id = $1`, [vehicleId]);
  return r.rows[0]?.group_id ?? null;
}

export async function attendIncident(deps: ModuleDeps, actor: Actor, id: string): Promise<IncidentDetail> {
  const incident = await getIncident(deps.db.core, actor, id);
  if (incident.status === "closed") throw badRequest(say("antitheft.errors.incidentClosed"));
  if (incident.status === "open") {
    await withTransaction(deps.db.core, async (client) => {
      await client.query(`UPDATE gps.incidents SET status = 'attended', attended_by = $2, attended_at = now() WHERE id = $1 AND status = 'open'`, [id, actor.userId]);
      await addEntry(client, id, "status", storedText(deps, say("antitheft.entry.attending")), { userId: actor.userId });
      await audit(client, actor, "incident.attend", "incident", id, { name: incident.vehicleName });
    });
    deps.bus.emit("incident", { orgId: actor.orgId, groupId: await groupOf(deps.db.core, incident.vehicleId), vehicleId: incident.vehicleId });
  }
  return getIncident(deps.db.core, actor, id);
}

export async function addNote(deps: ModuleDeps, actor: Actor, id: string, text: string): Promise<IncidentDetail> {
  const incident = await getIncident(deps.db.core, actor, id);
  if (incident.status === "closed") throw badRequest(say("antitheft.errors.incidentClosed"));
  await addEntry(deps.db.core, id, "note", text, { userId: actor.userId });
  deps.bus.emit("incident", { orgId: actor.orgId, groupId: await groupOf(deps.db.core, incident.vehicleId), vehicleId: incident.vehicleId });
  return getIncident(deps.db.core, actor, id);
}

export async function closeIncident(deps: ModuleDeps, actor: Actor, id: string, input: { resolution: IncidentResolution; note: string }): Promise<IncidentDetail> {
  const incident = await getIncident(deps.db.core, actor, id);
  if (incident.status === "closed") throw badRequest(say("antitheft.errors.incidentClosed"));
  const language = deps.config.defaultLanguage; // i18n: stored text
  const resolution = tr(language, `shared.incidentResolution.${input.resolution}`).toLowerCase();
  const closing = input.note ? tr(language, "antitheft.entry.closedWithNote", { resolution, note: input.note }) : tr(language, "antitheft.entry.closed", { resolution });
  await withTransaction(deps.db.core, async (client) => {
    await client.query(
      `UPDATE gps.incidents SET status = 'closed', closed_by = $2, closed_at = now(), resolution = $3,
              attended_by = COALESCE(attended_by, $2), attended_at = COALESCE(attended_at, now())
        WHERE id = $1`,
      [id, actor.userId, input.resolution],
    );
    await addEntry(client, id, "status", closing, { userId: actor.userId });
    await audit(client, actor, "incident.close", "incident", id, { name: incident.vehicleName, resolution: input.resolution });
  });
  deps.bus.emit("incident", { orgId: actor.orgId, groupId: await groupOf(deps.db.core, incident.vehicleId), vehicleId: incident.vehicleId });
  return getIncident(deps.db.core, actor, id);
}

// ─── Evidence ────────────────────────────────────────────────────────────────

/** Each incident keeps its files in its own folder, inside that of its account. */
const folderOf = (deps: Pick<ModuleDeps, "config">, orgId: string, incidentId: string) => filesFolder(deps.config, "incidents", orgId, incidentId);
/** Display name: no paths or odd characters. The file on disk is named by its identifier. */
const cleanName = (name: string, language: Language) =>
  name
    .replace(/[/\\]/g, " ")
    // oxlint-disable-next-line no-control-regex -- removed on purpose
    .replace(/[\u0000-\u001F<>:"|?*]/g, "")
    .trim()
    .slice(0, 120) || tr(language, "antitheft.evidence.unnamed");

export async function addEvidence(deps: ModuleDeps, actor: Actor, id: string, file: { name: string; mime: string; data: Buffer }): Promise<IncidentDetail> {
  const incident = await getIncident(deps.db.core, actor, id);
  if (incident.status === "closed") throw badRequest(say("antitheft.errors.incidentClosed"));
  if (!EVIDENCE_TYPES.includes(file.mime)) throw badRequest(say("antitheft.errors.fileType"));
  if (file.data.length === 0) throw badRequest(say("shared.validation.fileEmpty"));
  if (file.data.length > deps.config.maxUploadMb * 1024 * 1024) throw badRequest(say("antitheft.errors.fileTooBig", { mb: deps.config.maxUploadMb }));
  if (incident.entries.filter((e) => e.file).length >= EVIDENCE_MAX_FILES) throw badRequest(say("antitheft.errors.tooManyFiles", { max: EVIDENCE_MAX_FILES }));
  const name = cleanName(file.name, deps.config.defaultLanguage); // i18n: stored text
  const fileId = await withTransaction(deps.db.core, async (client) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO gps.incident_files (incident_id, org_id, name, mime, size, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [id, actor.orgId, name, file.mime, file.data.length, actor.userId],
    );
    const created = (r.rows[0] as { id: string }).id;
    await addEntry(client, id, "evidence", storedText(deps, say("antitheft.entry.attached", { name })), { userId: actor.userId, fileId: created });
    // The file is written inside the transaction: if the disk fails, no row is left without a file.
    await mkdir(folderOf(deps, actor.orgId, id), { recursive: true });
    await writeFile(join(folderOf(deps, actor.orgId, id), created), file.data);
    return created;
  });
  await audit(deps.db.core, actor, "incident.evidence", "incident", id, { name: incident.vehicleName, file: name, fileId });
  deps.bus.emit("incident", { orgId: actor.orgId, groupId: await groupOf(deps.db.core, incident.vehicleId), vehicleId: incident.vehicleId });
  return getIncident(deps.db.core, actor, id);
}

export async function readEvidence(deps: ModuleDeps, tenant: Tenant, id: string, fileId: string): Promise<{ name: string; mime: string; data: Buffer }> {
  const incident = await getIncident(deps.db.core, tenant, id);
  const file = incident.entries.find((e) => e.file?.id === fileId)?.file;
  if (!file || !isUuid(fileId)) throw notFound(say("antitheft.errors.fileNotFound"));
  try {
    return { name: file.name, mime: file.mime, data: await readFile(join(folderOf(deps, tenant.orgId, id), fileId)) };
  } catch {
    throw notFound(say("antitheft.errors.fileGone"));
  }
}

/** Deletes from disk the files of an account being deleted. */
export async function dropEvidence(deps: Pick<ModuleDeps, "config">, orgId: string): Promise<void> {
  await rm(filesFolder(deps.config, "incidents", orgId), { recursive: true, force: true });
}

/**
 * Cleanup: deleting a vehicle removes its incidents from the database, and here
 * the folders of incidents that no longer exist are removed from disk.
 */
export async function pruneEvidence(deps: Pick<ModuleDeps, "config" | "db">): Promise<number> {
  const root = filesFolder(deps.config, "incidents");
  const orgs = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const orgId of orgs) {
    const folders = (await readdir(join(root, orgId)).catch(() => [] as string[])).filter((name) => isUuid(name));
    if (folders.length === 0) continue;
    const alive = await deps.db.core.query<{ id: string }>(`SELECT id FROM gps.incidents WHERE id = ANY($1::uuid[])`, [folders]);
    const keep = new Set(alive.rows.map((r) => r.id));
    for (const folder of folders) {
      if (keep.has(folder)) continue;
      await rm(join(root, orgId, folder), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// ─── Escalation ──────────────────────────────────────────────────────────────

/** Panic buttons still unattended: notified again, each time more insistently. */
export async function escalate(deps: ModuleDeps, now = Date.now(), orgId: string | null = null): Promise<number> {
  const r = await deps.db.core.query<{ id: string; org_id: string; vehicle_id: string; name: string; group_id: string | null; opened_at: Date; escalation: number }>(
    `SELECT i.id, i.org_id, i.vehicle_id, v.name, v.group_id, i.opened_at, i.escalation
       FROM gps.incidents i JOIN gps.vehicles v ON v.id = i.vehicle_id
      WHERE i.kind = 'sos' AND i.status = 'open' AND i.escalation < $1 AND ($2::text IS NULL OR i.org_id = $2)`,
    [SOS_ESCALATION_MIN.length, orgId],
  );
  let count = 0;
  for (const row of r.rows) {
    const minutes = (now - row.opened_at.getTime()) / 60_000;
    const due = SOS_ESCALATION_MIN[row.escalation] as number;
    if (minutes < due) continue;
    if (!(await deps.gate.enabled(row.org_id, "A"))) continue;
    const moved = await deps.db.core.query(`UPDATE gps.incidents SET escalation = escalation + 1 WHERE id = $1 AND status = 'open' AND escalation = $2`, [row.id, row.escalation]);
    if (moved.rowCount === 0) continue;
    await addEntry(deps.db.core, row.id, "escalation", storedText(deps, say("antitheft.entry.escalated", { minutes: due })));
    await mailManagers(deps, row.org_id, "panicUnattended", () => ({ vehicle: row.name, minutes: Math.round(minutes) }));
    deps.bus.emit("incident", { orgId: row.org_id, groupId: row.group_id, vehicleId: row.vehicle_id });
    count++;
  }
  return count;
}
