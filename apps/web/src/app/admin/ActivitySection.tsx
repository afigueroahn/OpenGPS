// Activity log: who did what and when, in the account or, for whoever
// administers the platform, across it.
import { type AuditEntry, REPORT_TYPES, type ReportType } from "@opengps/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../../components/ui";
import { getAdminAudit, getAudit } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import i18n from "../../lib/i18n";
import { errorText } from "../widgets";

type Detail = Record<string, unknown>;
/** Whether a detail holds a value that can be written. */
const given = (v: unknown) => typeof v === "string" || typeof v === "number";
const text = (v: unknown, fallback = "") => (given(v) ? String(v) : fallback);

const isReport = (type: unknown): type is ReportType => REPORT_TYPES.includes(type as ReportType);

/**
 * Phrase for each logged operation. Its text is "activity.actions.<action>"
 * (a test reads the catalog to check every recorded action has one); a
 * phrase with an optional part has a second text, "<action>_<variant>".
 */
const ACTIONS: Record<string, (d: Detail) => string> = {
  "vehicle.create": (d) => i18n.t("activity.actions.vehicle.create", { name: text(d.name), uniqueId: text(d.uniqueId) }),
  "vehicle.update": (d) => (d.name ? i18n.t("activity.actions.vehicle.update_name", { name: text(d.name) }) : i18n.t("activity.actions.vehicle.update")),
  "vehicle.delete": (d) => i18n.t("activity.actions.vehicle.delete", { name: text(d.name) }),
  "history.export": (d) => i18n.t("activity.actions.history.export", { name: text(d.name), format: text(d.format).toUpperCase() }),
  "share.create": (d) => (d.note ? i18n.t("activity.actions.share.create_note", { name: text(d.name), note: text(d.note) }) : i18n.t("activity.actions.share.create", { name: text(d.name) })),
  "share.revoke": (d) => i18n.t("activity.actions.share.revoke", { name: text(d.name) }),
  "vehicle.park": (d) => i18n.t("activity.actions.vehicle.park", { name: text(d.name) }),
  "vehicle.unpark": (d) => i18n.t("activity.actions.vehicle.unpark", { name: text(d.name) }),
  "alert.create": (d) => i18n.t("activity.actions.alert.create", { name: text(d.name) }),
  "alert.update": (d) => i18n.t("activity.actions.alert.update", { name: text(d.name) }),
  "alert.delete": (d) => i18n.t("activity.actions.alert.delete", { name: text(d.name) }),
  "geofence.create": (d) => i18n.t("activity.actions.geofence.create", { name: text(d.name) }),
  "geofence.update": (d) => i18n.t("activity.actions.geofence.update", { name: text(d.name) }),
  "geofence.delete": (d) => i18n.t("activity.actions.geofence.delete", { name: text(d.name) }),
  "device.attach": (d) => i18n.t("activity.actions.device.attach", { uniqueId: text(d.uniqueId) }),
  "device.remove": (d) => i18n.t("activity.actions.device.remove", { uniqueId: text(d.uniqueId) }),
  "device.claim_expired": (d) => i18n.t("activity.actions.device.claim_expired", { uniqueId: text(d.uniqueId) }),
  "group.create": (d) => i18n.t("activity.actions.group.create", { name: text(d.name) }),
  "group.rename": (d) => i18n.t("activity.actions.group.rename", { name: text(d.name) }),
  "group.delete": () => i18n.t("activity.actions.group.delete"),
  "member.invite": (d) => i18n.t("activity.actions.member.invite", { email: text(d.email), role: text(d.role) }),
  "member.invite_cancel": (d) => i18n.t("activity.actions.member.invite_cancel", { email: text(d.email) }),
  "member.join": (d) => i18n.t("activity.actions.member.join", { email: text(d.email) }),
  "member.update": (d) => (d.role ? i18n.t("activity.actions.member.update_role", { email: text(d.email), role: text(d.role) }) : i18n.t("activity.actions.member.update", { email: text(d.email) })),
  "member.block": (d) => i18n.t("activity.actions.member.block", { email: text(d.email) }),
  "member.unblock": (d) => i18n.t("activity.actions.member.unblock", { email: text(d.email) }),
  "member.remove": (d) => i18n.t("activity.actions.member.remove", { email: text(d.email) }),
  "member.leave": (d) => i18n.t("activity.actions.member.leave", { email: text(d.email) }),
  "role.create": (d) => i18n.t("activity.actions.role.create", { name: text(d.name) }),
  "role.update": (d) => i18n.t("activity.actions.role.update", { name: text(d.name) }),
  "role.delete": (d) => i18n.t("activity.actions.role.delete", { name: text(d.name) }),
  "command.lock": (d) => i18n.t("activity.actions.command.lock", { name: text(d.name) }),
  "command.unlock": (d) => i18n.t("activity.actions.command.unlock", { name: text(d.name) }),
  "command.cancel": (d) => i18n.t("activity.actions.command.cancel", { name: text(d.name) }),
  "recovery.on": (d) => i18n.t("activity.actions.recovery.on", { name: text(d.name) }),
  "recovery.off": (d) => i18n.t("activity.actions.recovery.off", { name: text(d.name) }),
  "incident.report": (d) => i18n.t("activity.actions.incident.report", { name: text(d.name) }),
  "incident.attend": (d) => i18n.t("activity.actions.incident.attend", { name: text(d.name) }),
  "incident.close": (d) => i18n.t("activity.actions.incident.close", { name: text(d.name) }),
  "incident.evidence": (d) => i18n.t("activity.actions.incident.evidence", { name: text(d.name) }),
  "driver.create": (d) => i18n.t("activity.actions.driver.create", { name: text(d.name) }),
  "driver.update": (d) => i18n.t("activity.actions.driver.update", { name: text(d.name) }),
  "driver.delete": (d) => i18n.t("activity.actions.driver.delete", { name: text(d.name) }),
  "driver.assign": (d) => i18n.t("activity.actions.driver.assign", { driver: text(d.driver), vehicle: text(d.vehicle) }),
  "driver.unassign": (d) => i18n.t("activity.actions.driver.unassign", { vehicle: text(d.vehicle) }),
  "driver.settings": () => i18n.t("activity.actions.driver.settings"),
  "fuel.configure": (d) => i18n.t("activity.actions.fuel.configure", { name: text(d.name) }),
  "report.export": (d) => {
    const format = text(d.format) === "xlsx" ? "Excel" : text(d.format).toUpperCase();
    return isReport(d.type)
      ? i18n.t("activity.actions.report.export", { report: i18n.t(`shared.report.${d.type}`).toLowerCase(), format })
      : i18n.t("activity.actions.report.export_data", { format });
  },
  "report.schedule.create": (d) => i18n.t("activity.actions.report.schedule.create", { name: text(d.name) }),
  "report.schedule.update": (d) => i18n.t("activity.actions.report.schedule.update", { name: text(d.name) }),
  "report.schedule.delete": (d) => i18n.t("activity.actions.report.schedule.delete", { name: text(d.name) }),
  "report.schedule.send": (d) => i18n.t("activity.actions.report.schedule.send", { name: text(d.name) }),
  "fuel.remove": (d) => i18n.t("activity.actions.fuel.remove", { name: text(d.name) }),
  "admin.account_suspend": (d) =>
    d.suspendedReason
      ? i18n.t("activity.actions.admin.account_suspend_reason", { suspendedReason: text(d.suspendedReason) })
      : i18n.t("activity.actions.admin.account_suspend"),
  "admin.account_unsuspend": () => i18n.t("activity.actions.admin.account_unsuspend"),
  "admin.account_update": () => i18n.t("activity.actions.admin.account_update"),
  "admin.backup": (d) => (d.ok === false ? i18n.t("activity.actions.admin.backup_failed") : i18n.t("activity.actions.admin.backup")),
  "admin.backup_delete": () => i18n.t("activity.actions.admin.backup_delete"),
  "admin.backup_restore": () => i18n.t("activity.actions.admin.backup_restore"),
  "admin.backup_restored": () => i18n.t("activity.actions.admin.backup_restored"),
  "admin.backup_discover": (d) => i18n.t("activity.actions.admin.backup_discover", { found: text(d.found, "0"), added: text(d.added, "0") }),
  "admin.backup_download": (d) => i18n.t("activity.actions.admin.backup_download", { name: text(d.name) }),
  "admin.update_install": (d) => i18n.t("activity.actions.admin.update_install", { version: text(d.version), from: text(d.from) }),
  "admin.notification.create": (d) => i18n.t("activity.actions.admin.notification.create", { name: text(d.name) }),
  "admin.notification.update": (d) => i18n.t("activity.actions.admin.notification.update", { name: text(d.name) }),
  "admin.notification.delete": (d) => i18n.t("activity.actions.admin.notification.delete", { name: text(d.name) }),
  "notification.create": (d) => i18n.t("activity.actions.notification.create", { name: text(d.name) }),
  "notification.update": (d) => i18n.t("activity.actions.notification.update", { name: text(d.name) }),
  "notification.delete": (d) => i18n.t("activity.actions.notification.delete", { name: text(d.name) }),
  "admin.settings": (d) => i18n.t("activity.actions.admin.settings", { section: text(d.section) }),
  "admin.settings_reset": (d) => i18n.t("activity.actions.admin.settings_reset", { section: text(d.section) }),
  "admin.user_ban": (d) => i18n.t("activity.actions.admin.user_ban", { email: text(d.email) }),
  "admin.account_delete": (d) => i18n.t("activity.actions.admin.account_delete", { name: text(d.name) }),
  "admin.user_delete": (d) => i18n.t("activity.actions.admin.user_delete", { email: text(d.email) }),
  "account.rename": (d) => i18n.t("activity.actions.account.rename", { name: text(d.name), before: text(d.before) }),
  "admin.user_unban": (d) => i18n.t("activity.actions.admin.user_unban", { email: text(d.email) }),
  "diag.limits": (d) => i18n.t("activity.actions.diag.limits", { name: text(d.name) }),
  "diag.settings": () => i18n.t("activity.actions.diag.settings"),
  "fleet.assign": (d) => i18n.t("activity.actions.fleet.assign", { name: text(d.name), person: text(d.person) }),
  "fleet.unassign": (d) => i18n.t("activity.actions.fleet.unassign", { person: text(d.person) }),
  "fleet.document.add": (d) => i18n.t("activity.actions.fleet.document.add", { file: text(d.file), name: text(d.name) }),
  "fleet.document.delete": (d) => i18n.t("activity.actions.fleet.document.delete", { file: text(d.file) }),
  "fleet.expense.create": (d) => i18n.t("activity.actions.fleet.expense.create", { amount: text(d.amount), currency: text(d.currency), name: text(d.name) }),
  "fleet.expense.update": (d) => i18n.t("activity.actions.fleet.expense.update", { name: text(d.name) }),
  "fleet.expense.delete": (d) => i18n.t("activity.actions.fleet.expense.delete", { amount: text(d.amount) }),
  "fleet.profile": (d) => i18n.t("activity.actions.fleet.profile", { name: text(d.name) }),
  "fleet.status": (d) => i18n.t("activity.actions.fleet.status", { name: text(d.name) }),
  "fleet.state": (d) => i18n.t("activity.actions.fleet.state", { name: text(d.name) }),
  "fuel.fill.create": (d) => i18n.t("activity.actions.fuel.fill.create", { liters: text(d.liters), name: text(d.name) }),
  "fuel.fill.update": (d) => i18n.t("activity.actions.fuel.fill.update", { liters: text(d.liters) }),
  "fuel.fill.delete": (d) => i18n.t("activity.actions.fuel.fill.delete", { liters: text(d.liters) }),
  "fuel.fill.import": (d) => i18n.t("activity.actions.fuel.fill.import", { imported: text(d.imported, "0") }),
  "fuel.settings": () => i18n.t("activity.actions.fuel.settings"),
  "group.move": (d) =>
    d.parent
      ? i18n.t("activity.actions.group.move", { name: text(d.name), parent: text(d.parent) })
      : i18n.t("activity.actions.group.move_top", { name: text(d.name) }),
  "integrations.automation.create": (d) => i18n.t("activity.actions.integrations.automation.create", { name: text(d.name) }),
  "integrations.automation.update": (d) => i18n.t("activity.actions.integrations.automation.update", { name: text(d.name) }),
  "integrations.automation.delete": (d) => i18n.t("activity.actions.integrations.automation.delete", { name: text(d.name) }),
  "integrations.key.create": (d) => i18n.t("activity.actions.integrations.key.create", { name: text(d.name) }),
  "integrations.key.revoke": (d) => i18n.t("activity.actions.integrations.key.revoke", { name: text(d.name) }),
  "integrations.sensor.create": (d) => i18n.t("activity.actions.integrations.sensor.create", { name: text(d.name) }),
  "integrations.sensor.update": (d) => i18n.t("activity.actions.integrations.sensor.update", { name: text(d.name) }),
  "integrations.sensor.delete": (d) => i18n.t("activity.actions.integrations.sensor.delete", { name: text(d.name) }),
  "integrations.sensor.key": (d) => i18n.t("activity.actions.integrations.sensor.key", { name: text(d.name) }),
  "integrations.webhook.create": (d) => i18n.t("activity.actions.integrations.webhook.create", { name: text(d.name) }),
  "integrations.webhook.update": (d) => i18n.t("activity.actions.integrations.webhook.update", { name: text(d.name) }),
  "integrations.webhook.delete": (d) => i18n.t("activity.actions.integrations.webhook.delete", { name: text(d.name) }),
  "integrations.webhook.secret": (d) => i18n.t("activity.actions.integrations.webhook.secret", { name: text(d.name) }),
  "maintenance.baseline": (d) => (given(d.plan) ? i18n.t("activity.actions.maintenance.baseline", { plan: text(d.plan) }) : i18n.t("activity.actions.maintenance.baseline_noPlan")),
  "maintenance.expiry.create": (d) => i18n.t("activity.actions.maintenance.expiry.create", { name: text(d.name) }),
  "maintenance.expiry.update": (d) => i18n.t("activity.actions.maintenance.expiry.update", { name: text(d.name) }),
  "maintenance.part.update": (d) => i18n.t("activity.actions.maintenance.part.update", { name: text(d.name) }),
  "maintenance.workshop.update": (d) => i18n.t("activity.actions.maintenance.workshop.update", { name: text(d.name) }),
  "routes.plan.update": (d) => i18n.t("activity.actions.routes.plan.update", { name: text(d.name) }),
  "routes.poi.update": (d) => i18n.t("activity.actions.routes.poi.update", { name: text(d.name) }),
  "maintenance.expiry.delete": () => i18n.t("activity.actions.maintenance.expiry.delete"),
  "maintenance.order.create": (d) => i18n.t("activity.actions.maintenance.order.create", { number: text(d.number), name: text(d.name) }),
  "maintenance.order.update": (d) => i18n.t("activity.actions.maintenance.order.update", { number: text(d.number) }),
  "maintenance.order.delete": (d) => i18n.t("activity.actions.maintenance.order.delete", { number: text(d.number) }),
  "maintenance.order.file": (d) => i18n.t("activity.actions.maintenance.order.file", { file: text(d.file), number: text(d.number) }),
  "maintenance.part.create": (d) => i18n.t("activity.actions.maintenance.part.create", { name: text(d.name) }),
  "maintenance.part.delete": (d) => i18n.t("activity.actions.maintenance.part.delete", { name: text(d.name) }),
  "maintenance.plan.create": (d) => i18n.t("activity.actions.maintenance.plan.create", { name: text(d.name) }),
  "maintenance.plan.update": (d) => i18n.t("activity.actions.maintenance.plan.update", { name: text(d.name) }),
  "maintenance.plan.delete": (d) => i18n.t("activity.actions.maintenance.plan.delete", { name: text(d.name) }),
  "maintenance.settings": () => i18n.t("activity.actions.maintenance.settings"),
  "maintenance.workshop.create": (d) => i18n.t("activity.actions.maintenance.workshop.create", { name: text(d.name) }),
  "maintenance.workshop.delete": (d) => i18n.t("activity.actions.maintenance.workshop.delete", { name: text(d.name) }),
  "meters.adjust": () => i18n.t("activity.actions.meters.adjust"),
  "routes.plan.create": (d) => i18n.t("activity.actions.routes.plan.create", { name: text(d.name) }),
  "routes.plan.delete": (d) => i18n.t("activity.actions.routes.plan.delete", { name: text(d.name) }),
  "routes.poi.create": (d) => i18n.t("activity.actions.routes.poi.create", { name: text(d.name) }),
  "routes.poi.delete": (d) => i18n.t("activity.actions.routes.poi.delete", { name: text(d.name) }),
  "routes.stop.link": (d) => i18n.t("activity.actions.routes.stop.link", { stop: text(d.stop), trip: text(d.trip) }),
  "routes.trip.create": (d) => i18n.t("activity.actions.routes.trip.create", { trip: text(d.trip), name: text(d.name) }),
  "routes.trip.delete": (d) => i18n.t("activity.actions.routes.trip.delete", { trip: text(d.trip) }),
  "routes.trip.link": (d) => i18n.t("activity.actions.routes.trip.link", { trip: text(d.trip) }),
  "routes.trip.status": (d) => i18n.t("activity.actions.routes.trip.status", { trip: text(d.trip) }),
};

const describe = (e: AuditEntry) => ACTIONS[e.action]?.(e.detail) ?? e.action;
/** Operations not performed by a person on the account, but by the platform. */
const BY_PLATFORM = (action: string) => action.startsWith("admin.") || action === "device.claim_expired";

/**
 * `platform` lists what the platform's administration did instead of the
 * account's activity. `latest` shows only that many entries, with no way to
 * load more: for a summary.
 */
export function ActivitySection({ platform = false, latest }: { platform?: boolean; latest?: number }) {
  const audit = useInfiniteQuery({
    queryKey: [platform ? "admin-audit" : "audit"],
    queryFn: ({ pageParam }) => (platform ? getAdminAudit(pageParam) : getAudit(pageParam)),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1]?.id : undefined),
    staleTime: 0,
  });
  const { t } = useTranslation();
  const all = audit.data?.pages.flat() ?? [];
  const entries = latest ? all.slice(0, latest) : all;

  return (
    <div>
      {audit.isLoading && (
        <div className="flex h-32 items-center justify-center text-muted">
          <Spinner />
        </div>
      )}
      {audit.isError && <Notice tone="error">{errorText(audit.error)}</Notice>}
      {audit.isSuccess && entries.length === 0 && <p className="text-sm text-muted">{t("activity.empty")}</p>}
      {entries.length > 0 && (
        <>
          {!latest && <p className="mb-3 text-[13px] text-muted">{t("activity.immutable")}</p>}
          <ol className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="py-2.5">
                <p className="text-sm leading-snug">
                  <strong className="font-semibold">{e.userName ?? (BY_PLATFORM(e.action) ? t("activity.byPlatform") : t("activity.deletedUser"))}</strong> {describe(e)}
                </p>
                <p className="num mt-0.5 text-[12px] text-muted">{formatDateTime(e.at)}</p>
              </li>
            ))}
          </ol>
          {!latest && audit.hasNextPage && (
            <div className="pt-3">
              <Button variant="secondary" size="sm" loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
                {t("activity.more")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
