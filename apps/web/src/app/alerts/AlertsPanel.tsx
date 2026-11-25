// Account alerts: the list, the type catalog and the editor for each one.
import {
  ALERT_NEEDS_DEVICE,
  ALERT_TYPES,
  type AlertCondition,
  type AlertRule,
  type AlertRuleInput,
  type AlertType,
  type Geofence,
  type Vehicle,
  type VehicleGroup,
  type WeekSchedule,
} from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowLeft,
  BatteryWarning,
  Gauge,
  Hexagon,
  KeyRound,
  type LucideIcon,
  ParkingCircle,
  Plus,
  Siren,
  SlidersHorizontal,
  Trash2,
  Truck,
  WifiOff,
  Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button, Spinner } from "../../components/ui";
import { deleteAlert, getAlerts, saveAlert } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import i18n from "../../lib/i18n";
import { Checks, OFFICE_HOURS, ScheduleEditor, Segment, input, label } from "../geofences/GeofencePanel";
import { ConfirmDialog, errorText } from "../widgets";

const ICON: Record<AlertType, LucideIcon> = {
  speeding: Gauge,
  ignition_off_hours: KeyRound,
  signal_lost: WifiOff,
  parked_movement: ParkingCircle,
  sos: Siren,
  power_cut: BatteryWarning,
  tow: Truck,
  harsh_driving: Zap,
  geofence: Hexagon,
  custom: SlidersHorizontal,
};

interface Props {
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  geofences: Geofence[];
  canManage: boolean;
  /** Groups this person sees; null = all. */
  scope: string[] | null;
  onBack: () => void;
}

type Screen = { view: "list" } | { view: "types" } | { view: "edit"; type: AlertType; alert: AlertRule | null };

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** What the server stores, with the starting values for each type. */
function blank(type: AlertType): AlertRuleInput {
  const base = { name: i18n.t(`shared.alertType.${type}`), schedule: null, vehicleIds: null, groupIds: null, active: true, zone: zone() };
  switch (type) {
    case "speeding":
      return { ...base, type, params: { limitKmh: 90, seconds: 20, geofenceId: null } };
    case "ignition_off_hours":
      return { ...base, type, params: { allowed: { zone: zone(), days: OFFICE_HOURS } } };
    case "signal_lost":
      return { ...base, type, params: { minutes: 30 } };
    case "parked_movement":
      return { ...base, type, params: { meters: 150 } };
    case "geofence":
      return { ...base, type, params: { geofenceIds: null } };
    case "custom":
      return { ...base, name: "", type, params: { conditions: [{ field: "speed", op: "gt", value: 100 }], seconds: 0 } };
    default:
      return { ...base, type, params: {} };
  }
}

/** "Más de 90 km/h durante 20 s" */
function summaryOf(alert: AlertRule, geofences: Geofence[]): string {
  const name = (id: string) => geofences.find((g) => g.id === id)?.name ?? i18n.t("alerts.summary.someGeofence");
  switch (alert.type) {
    case "speeding": {
      const { limitKmh: limit, seconds, geofenceId } = alert.params;
      const values = { limit, seconds, place: geofenceId ? name(geofenceId) : "" };
      if (seconds > 0) return geofenceId ? i18n.t("alerts.summary.speedingForIn", values) : i18n.t("alerts.summary.speedingFor", values);
      return geofenceId ? i18n.t("alerts.summary.speedingIn", values) : i18n.t("alerts.summary.speeding", values);
    }
    case "signal_lost":
      return i18n.t("alerts.summary.signalLost", { time: formatDuration(alert.params.minutes * 60) });
    case "parked_movement":
      return i18n.t("alerts.summary.parkedMovement", { meters: alert.params.meters });
    case "geofence":
      return alert.params.geofenceIds
        ? alert.params.geofenceIds.length === 1
          ? name(alert.params.geofenceIds[0] as string)
          : i18n.t("alerts.summary.geofences", { count: alert.params.geofenceIds.length })
        : i18n.t("alerts.summary.allGeofences");
    case "custom":
      return i18n.t("alerts.summary.conditions", { count: alert.params.conditions.length });
    default:
      return i18n.t(`shared.alertTypeNote.${alert.type}`);
  }
}

export function AlertsPanel(props: Props) {
  const { t } = useTranslation();
  const [screen, setScreen] = useState<Screen>({ view: "list" });
  const queryClient = useQueryClient();
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: getAlerts });
  const toggle = useMutation({
    mutationFn: (alert: AlertRule) => {
      const { id, createdAt: _created, ...rest } = alert;
      return saveAlert({ ...rest, active: !alert.active } as AlertRuleInput, id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });

  if (screen.view === "edit") {
    return <Editor key={screen.alert?.id ?? screen.type} {...props} type={screen.type} alert={screen.alert} onClose={() => setScreen({ view: "list" })} />;
  }

  const list = alerts.data ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button
          type="button"
          onClick={screen.view === "types" ? () => setScreen({ view: "list" }) : props.onBack}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white"
        >
          <ArrowLeft size={15} /> {screen.view === "types" ? t("alerts.title") : t("common.myVehicles")}
        </button>
      </div>

      {screen.view === "types" ? (
        <>
          <h1 className="px-5 pb-3 pt-2 text-[22px] font-semibold tracking-tight">{t("alerts.types.title")}</h1>
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
            {ALERT_TYPES.map((type) => {
              const Icon = ICON[type];
              return (
                <li key={type}>
                  <button
                    type="button"
                    onClick={() => setScreen({ view: "edit", type, alert: null })}
                    className="flex w-full items-start gap-3 rounded-[12px] bg-ink-2 px-3 py-3 text-left transition-colors hover:bg-ink-3"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-ink text-signal">
                      <Icon size={17} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold">{t(`shared.alertType.${type}`)}</span>
                      <span className="block text-[13px] leading-snug text-white/55">{t(`shared.alertTypeNote.${type}`)}</span>
                      {ALERT_NEEDS_DEVICE.includes(type) && <span className="mt-1 block text-[12px] text-apricot">{t("alerts.types.needsDevice")}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-2">
            <h1 className="text-[22px] font-semibold tracking-tight">{t("alerts.title")}</h1>
            {props.canManage && (
              <Button variant="signal" size="sm" onClick={() => setScreen({ view: "types" })}>
                <Plus size={15} strokeWidth={2.5} /> {t("alerts.new")}
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {alerts.isLoading && (
              <div className="flex h-28 items-center justify-center text-white/50">
                <Spinner />
              </div>
            )}
            {alerts.isError && <p className="px-2 py-4 text-sm text-white/60">{errorText(alerts.error)}</p>}
            {alerts.isSuccess && list.length === 0 && (
              <p className="mx-2 rounded-[14px] bg-ink-2 p-4 text-sm leading-relaxed text-white/60">{t("alerts.empty")}</p>
            )}
            <ul className="space-y-1.5">
              {list.map((alert) => {
                const Icon = ICON[alert.type];
                return (
                  <li key={alert.id} className={clsx("flex items-center gap-1 rounded-[12px] pr-3 transition-colors hover:bg-ink-2", !alert.active && "opacity-60")}>
                    <button type="button" onClick={() => setScreen({ view: "edit", type: alert.type, alert })} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-ink-2 text-signal">
                        <Icon size={17} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[15px] font-semibold">{alert.name}</span>
                        </span>
                        <span className="block truncate text-[13px] text-white/55">{summaryOf(alert, props.geofences)}</span>
                      </span>
                    </button>
                    {props.canManage && (
                      <Switch checked={alert.active} label={alert.active ? t("alerts.switchOn", { name: alert.name }) : t("alerts.switchOff", { name: alert.name })} disabled={toggle.isPending} onChange={() => toggle.mutate(alert)} />
                    )}
                  </li>
                );
              })}
            </ul>
            {toggle.isError && <p className="mx-2 mt-3 text-[13px] text-coral">{errorText(toggle.error)}</p>}
            {list.length > 0 && (
              <p className="mx-2 mt-4 text-[12.5px] leading-relaxed text-white/45">
                {t("alerts.footnote")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Switch({ checked, onChange, label: text, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={text}
      disabled={disabled}
      onClick={onChange}
      className={clsx("relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-signal" : "bg-ink-3")}
    >
      <span className={clsx("absolute top-1 h-5 w-5 rounded-full bg-white transition-all", checked ? "left-6" : "left-1")} />
    </button>
  );
}

// ─── Editor ──────────────────────────────────────────────────────────────────

function Editor(props: Props & { type: AlertType; alert: AlertRule | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { alert, type, geofences, groups, vehicles } = props;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AlertRuleInput>(() => {
    if (!alert) return blank(type);
    const { id: _id, createdAt: _created, ...rest } = alert;
    return rest as AlertRuleInput;
  });
  const [confirming, setConfirming] = useState(false);
  const set = (patch: Partial<AlertRuleInput>) => setDraft((d) => ({ ...d, ...patch }) as AlertRuleInput);
  /** Changes a field specific to the alert type. */
  const param = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, params: { ...d.params, ...patch } }) as AlertRuleInput);

  const save = useMutation({
    mutationFn: () => saveAlert({ ...draft, name: draft.name.trim(), zone: zone() }, alert?.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
      props.onClose();
    },
  });

  // Someone who only sees some groups does not create alerts for the whole account.
  const scoped = props.scope !== null;
  const myGroups = groups.filter((g) => !scoped || props.scope?.includes(g.id));
  // Without groups of their own, what they can choose is vehicles.
  const target: "all" | "groups" | "vehicles" = draft.vehicleIds ? "vehicles" : draft.groupIds || (scoped && myGroups.length > 0) ? "groups" : scoped ? "vehicles" : "all";
  const withDevice = vehicles.filter((v) => v.device);
  const incomplete =
    !draft.name.trim() ||
    (target === "groups" && !scoped && (draft.groupIds?.length ?? 0) === 0) ||
    (target === "vehicles" && (draft.vehicleIds?.length ?? 0) === 0) ||
    (draft.schedule?.days.every((d) => d === null) ?? false) ||
    (draft.type === "ignition_off_hours" && draft.params.allowed.days.every((d) => d === null)) ||
    (draft.type === "geofence" && draft.params?.geofenceIds?.length === 0) ||
    (draft.type === "custom" && draft.params.conditions.some((c) => c.field === "geofence" && !c.geofenceId));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button
          type="button"
          onClick={props.onClose}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white"
        >
          <ArrowLeft size={15} /> {t("alerts.title")}
        </button>
      </div>
      <form
        className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-5 pb-5 pt-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!incomplete) save.mutate();
        }}
      >
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{t(`shared.alertType.${type}`)}</h1>
          <p className="mt-1 text-sm leading-relaxed text-white/60">{t(`shared.alertTypeNote.${type}`)}.</p>
          {ALERT_NEEDS_DEVICE.includes(type) && <p className="mt-1 text-[13px] text-apricot">{t("alerts.editor.needsDevice")}</p>}
        </div>

        <label className="block">
          <span className={label}>{t("common.name")}</span>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} placeholder={t("alerts.editor.namePlaceholder")} className={input} />
        </label>

        {draft.type === "speeding" && (
          <fieldset className="space-y-2">
            <legend className={label}>{t("alerts.editor.limit")}</legend>
            <NumberRow label={t("alerts.editor.above")} unit="km/h" value={draft.params.limitKmh} min={10} max={250} onChange={(limitKmh) => param({ limitKmh })} />
            <NumberRow label={t("alerts.editor.lasting")} unit="s" value={draft.params.seconds ?? 20} min={0} max={600} onChange={(seconds) => param({ seconds })} />
            {geofences.length > 0 && (
              <label className="block pt-1">
                <span className="mb-1.5 block text-sm text-white/70">{t("alerts.editor.where")}</span>
                <select value={draft.params.geofenceId ?? ""} onChange={(e) => param({ geofenceId: e.target.value || null })} className={clsx(input, "text-sm")}>
                  <option value="">{t("alerts.editor.anywhere")}</option>
                  {geofences.map((g) => (
                    <option key={g.id} value={g.id}>
                      {t("alerts.editor.onlyInside", { name: g.name })}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
        )}

        {draft.type === "ignition_off_hours" && (
          <ScheduleEditor title={t("alerts.editor.allowedHours")} required schedule={draft.params.allowed} onChange={(allowed) => allowed && param({ allowed })} />
        )}

        {draft.type === "signal_lost" && (
          <fieldset>
            <legend className={label}>{t("alerts.editor.silence")}</legend>
            <NumberRow label={t("alerts.editor.silentFor")} unit="min" value={draft.params.minutes} min={5} max={10080} onChange={(minutes) => param({ minutes })} />
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/45">{t("alerts.editor.silenceNote")}</p>
          </fieldset>
        )}

        {draft.type === "parked_movement" && (
          <fieldset>
            <legend className={label}>{t("alerts.editor.distance")}</legend>
            <NumberRow label={t("alerts.editor.movesAway")} unit="m" value={draft.params?.meters ?? 150} min={50} max={2000} onChange={(meters) => param({ meters })} />
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/45">{t("alerts.editor.parkedNote")}</p>
          </fieldset>
        )}

        {draft.type === "geofence" && (
          <fieldset>
            <legend className={label}>{t("alerts.editor.whichGeofences")}</legend>
            <div className="mb-2 flex gap-1 rounded-[10px] bg-ink-2 p-1">
              <Segment active={!draft.params?.geofenceIds} onClick={() => param({ geofenceIds: null })}>
                {t("alerts.editor.allGeofences")}
              </Segment>
              <Segment active={Boolean(draft.params?.geofenceIds)} onClick={() => param({ geofenceIds: draft.params?.geofenceIds ?? [] })}>
                {t("alerts.editor.someGeofences")}
              </Segment>
            </div>
            {draft.params?.geofenceIds && (
              <Checks
                items={geofences.map((g) => ({ id: g.id, name: g.name }))}
                chosen={draft.params.geofenceIds}
                onChange={(geofenceIds) => param({ geofenceIds })}
                empty={t("alerts.editor.noGeofences")}
              />
            )}
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/45">{t("alerts.editor.geofenceNote")}</p>
          </fieldset>
        )}

        {draft.type === "custom" && (
          <Conditions
            conditions={draft.params.conditions as AlertCondition[]}
            seconds={draft.params.seconds ?? 0}
            geofences={geofences}
            onChange={(conditions) => param({ conditions })}
            onSeconds={(seconds) => param({ seconds })}
          />
        )}

        {draft.type !== "ignition_off_hours" && <ScheduleEditor title={t("alerts.editor.watchWhen")} schedule={draft.schedule ?? null} onChange={(schedule: WeekSchedule | null) => set({ schedule })} />}

        <fieldset>
          <legend className={label}>{t("alerts.editor.vehicles")}</legend>
          <div className="mb-2 flex gap-1 rounded-[10px] bg-ink-2 p-1">
            {!scoped && (
              <Segment active={target === "all"} onClick={() => set({ vehicleIds: null, groupIds: null })}>
                {t("common.all")}
              </Segment>
            )}
            {myGroups.length > 0 && (
              <Segment active={target === "groups"} onClick={() => set({ vehicleIds: null, groupIds: draft.groupIds ?? [] })}>
                {t("common.groups")}
              </Segment>
            )}
            <Segment active={target === "vehicles"} onClick={() => set({ groupIds: null, vehicleIds: draft.vehicleIds ?? [] })}>
              {t("common.vehicles")}
            </Segment>
          </div>
          {target === "groups" && (
            <Checks
              items={myGroups.map((g) => ({ id: g.id, name: g.name, note: String(g.vehicleCount) }))}
              chosen={draft.groupIds ?? (scoped ? (props.scope ?? []) : [])}
              onChange={(groupIds) => set({ groupIds })}
              empty={t("alerts.editor.noGroups")}
            />
          )}
          {target === "vehicles" && (
            <Checks
              items={withDevice.map((v) => ({ id: v.id, name: v.name, note: v.plate ?? "" }))}
              chosen={draft.vehicleIds ?? []}
              onChange={(vehicleIds) => set({ vehicleIds })}
              empty={t("alerts.editor.noVehicles")}
            />
          )}
        </fieldset>

        <p className="rounded-[12px] bg-ink-2 px-4 py-3 text-[13px] leading-snug text-white/60">
          <Trans
            i18nKey="alerts.editor.whoIsNotified"
            components={{ admin: <Link to="/admin/notifications" className="font-semibold text-signal hover:underline" /> }}
          />
        </p>

        {save.isError && <p className="rounded-[12px] bg-danger/20 px-4 py-3 text-sm text-blush">{errorText(save.error)}</p>}

        <div className="flex items-center gap-2">
          <Button type="submit" variant="signal" loading={save.isPending} disabled={incomplete} className="flex-1">
            {alert ? t("alerts.editor.save") : t("alerts.editor.create")}
          </Button>
          <button type="button" onClick={props.onClose} className="h-10 rounded-[10px] px-4 text-sm font-semibold text-white/70 hover:bg-ink-2 hover:text-white">
            {t("common.cancel")}
          </button>
        </div>
        {alert && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-coral hover:bg-ink-2"
          >
            <Trash2 size={15} /> {t("alerts.editor.delete")}
          </button>
        )}
      </form>

      {alert && (
        <ConfirmDialog
          open={confirming}
          title={t("alerts.remove.title")}
          confirm={t("alerts.remove.confirm")}
          onClose={() => setConfirming(false)}
          action={async () => {
            await deleteAlert(alert.id);
            await queryClient.invalidateQueries({ queryKey: ["alerts"] });
          }}
          onDone={props.onClose}
        >
          <Trans i18nKey="alerts.remove.body" values={{ name: alert.name }} components={{ b: <strong className="font-semibold" /> }} />
        </ConfirmDialog>
      )}
    </div>
  );
}

function NumberRow({ label: text, unit, value, min, max, onChange }: { label: string; unit: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [typed, setTyped] = useState(String(value));
  const apply = () => {
    const n = Math.round(Number(typed));
    if (typed.trim() === "" || !Number.isFinite(n)) return setTyped(String(value));
    const fixed = Math.min(max, Math.max(min, n));
    setTyped(String(fixed));
    onChange(fixed);
  };
  return (
    <label className="flex items-center gap-3">
      <span className="flex-1 text-sm text-white/70">{text}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
        className="num h-10 w-24 shrink-0 rounded-[10px] border-0 bg-ink-2 px-3 text-right text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      />
      <span className="w-9 text-sm text-white/50">{unit}</span>
    </label>
  );
}

// ─── Conditions of a custom alert ─────────────────────────────────

/** The data a condition can look at, in the order they are offered. */
const FIELDS = ["speed", "ignition", "geofence", "power", "battery"] as const satisfies readonly AlertCondition["field"][];
const select = "h-9 rounded-lg border-0 bg-ink px-2 text-[13px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal";

function Conditions(props: {
  conditions: AlertCondition[];
  seconds: number;
  geofences: Geofence[];
  onChange: (conditions: AlertCondition[]) => void;
  onSeconds: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  const { conditions, geofences } = props;
  const replace = (index: number, next: AlertCondition) => props.onChange(conditions.map((c, i) => (i === index ? next : c)));
  const fresh = (field: AlertCondition["field"]): AlertCondition => {
    if (field === "speed") return { field, op: "gt", value: 100 };
    if (field === "ignition") return { field, value: true };
    if (field === "geofence") return { field, inside: true, geofenceId: geofences[0]?.id ?? "" };
    if (field === "power") return { field, op: "lt", value: 11.5 };
    return { field, op: "lt", value: 20 };
  };
  const number = (c: Extract<AlertCondition, { value: number }>, index: number, unit: string): ReactNode => (
    <>
      <input
        type="number"
        inputMode="decimal"
        value={c.value}
        onChange={(e) => replace(index, { ...c, value: Number(e.target.value) || 0 } as AlertCondition)}
        className="num h-9 w-20 rounded-lg border-0 bg-ink px-2 text-right text-[13px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      />
      <span className="text-[13px] text-white/50">{unit}</span>
    </>
  );
  return (
    <fieldset>
      <legend className={label}>{t("alerts.conditions.title")}</legend>
      <ul className="space-y-1.5">
        {conditions.map((c, index) => (
          <li key={`${index}-${c.field}`} className="flex flex-wrap items-center gap-1.5 rounded-[12px] bg-ink-2 p-2">
            <select value={c.field} onChange={(e) => replace(index, fresh(e.target.value as AlertCondition["field"]))} className={select} aria-label={t("alerts.conditions.field")}>
              {FIELDS.filter((field) => field !== "geofence" || geofences.length > 0).map((field) => (
                <option key={field} value={field}>
                  {t(`alerts.field.${field}`)}
                </option>
              ))}
            </select>
            {(c.field === "speed" || c.field === "power") && (
              <>
                <select value={c.op} onChange={(e) => replace(index, { ...c, op: e.target.value as "gt" | "lt" })} className={select} aria-label={t("alerts.conditions.comparison")}>
                  <option value="gt">{t("alerts.conditions.greater")}</option>
                  <option value="lt">{t("alerts.conditions.less")}</option>
                </select>
                {number(c, index, c.field === "speed" ? "km/h" : "V")}
              </>
            )}
            {c.field === "battery" && (
              <>
                <span className="text-[13px] text-white/60">{t("alerts.conditions.less")}</span>
                {number(c, index, "%")}
              </>
            )}
            {c.field === "ignition" && (
              <select value={c.value ? "on" : "off"} onChange={(e) => replace(index, { ...c, value: e.target.value === "on" })} className={select} aria-label={t("alerts.conditions.engine")}>
                <option value="on">{t("alerts.conditions.on")}</option>
                <option value="off">{t("alerts.conditions.off")}</option>
              </select>
            )}
            {c.field === "geofence" && (
              <>
                <select value={c.inside ? "in" : "out"} onChange={(e) => replace(index, { ...c, inside: e.target.value === "in" })} className={select} aria-label={t("alerts.conditions.insideOrOut")}>
                  <option value="in">{t("alerts.conditions.inside")}</option>
                  <option value="out">{t("alerts.conditions.outside")}</option>
                </select>
                <select value={c.geofenceId} onChange={(e) => replace(index, { ...c, geofenceId: e.target.value })} className={clsx(select, "min-w-0 max-w-[150px] flex-1")} aria-label={t("alerts.conditions.geofence")}>
                  {geofences.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            {conditions.length > 1 && (
              <button
                type="button"
                onClick={() => props.onChange(conditions.filter((_, i) => i !== index))}
                aria-label={t("alerts.conditions.remove")}
                className="ml-auto rounded-lg p-1.5 text-white/50 hover:bg-ink-3 hover:text-white"
              >
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {conditions.length < 6 && (
        <button
          type="button"
          onClick={() => props.onChange([...conditions, fresh("ignition")])}
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink-2 px-2.5 text-[12.5px] font-medium text-white/75 hover:bg-ink-3 hover:text-white"
        >
          <Plus size={14} /> {t("alerts.conditions.add")}
        </button>
      )}
      <div className="mt-3">
        <NumberRow label={t("alerts.conditions.lasting")} unit="s" value={props.seconds} min={0} max={3600} onChange={props.onSeconds} />
      </div>
    </fieldset>
  );
}
