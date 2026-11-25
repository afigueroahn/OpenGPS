// Account geofences: the list and the editor used to draw them on the map.
import {
  GEOFENCE_KINDS,
  GEOFENCE_LIMITS,
  type Geofence,
  type GeofenceInput,
  type GeofenceKind,
  type Vehicle,
  type VehicleGroup,
  WEEKDAY_KEYS,
  type WeekSchedule,
  geometryProblem,
  isActive,
  minuteLabel,
} from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import i18n, { sayShared } from "../../lib/i18n";
import clsx from "clsx";
import { ArrowLeft, Circle, Pentagon, Plus, Route, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Spinner } from "../../components/ui";
import { deleteGeofence, saveGeofence } from "../../lib/api";
import { ConfirmDialog, errorText } from "../widgets";
import { type GeofenceDraft, clampRadius, colorOf, colorOfGeofence, draftOf, emptyDraft, geometryOf, pointsOf, withoutLast } from "./draft";

/** What the editor asks of the map: what is drawn, in what color and which geofence is hidden meanwhile. */
export interface Editing {
  id: string | null;
  draft: GeofenceDraft;
  color: string;
}

interface Props {
  geofences: Geofence[];
  loading: boolean;
  groups: VehicleGroup[];
  /** The vehicles this person sees. */
  vehicles: Vehicle[];
  canManage: boolean;
  /** Groups this person sees; null = all. */
  scope: string[] | null;
  editing: Editing | null;
  onEditing: (editing: Editing | null) => void;
  /** Frames a geofence on the map. */
  onShow: (geofence: Geofence) => void;
  onEvents: () => void;
  onBack: () => void;
}

const SHAPE_ICON = { circle: Circle, polygon: Pentagon, corridor: Route } as const;

export function GeofencePanel(props: Props) {
  const { t } = useTranslation();
  const { geofences, editing, onEditing, canManage } = props;
  const [target, setTarget] = useState<Geofence | null>(null);
  const start = (geofence: Geofence | null) => {
    setTarget(geofence);
    onEditing({
      id: geofence?.id ?? null,
      draft: geofence ? draftOf(geofence.geometry) : emptyDraft("circle"),
      color: geofence ? colorOfGeofence(geofence) : colorOf("notify", "circle"),
    });
    if (geofence) props.onShow(geofence);
  };
  // Someone who only sees part of the account can see a geofence that covers more, but not change it.
  const editable = (g: Geofence) =>
    canManage &&
    (props.scope === null ||
      (g.vehicleIds !== null ? g.vehicleIds.every((id) => props.vehicles.some((v) => v.id === id)) : g.groupIds !== null && g.groupIds.every((id) => props.scope?.includes(id))));

  if (editing) {
    return <Editor key={target?.id ?? "nueva"} {...props} editing={editing} geofence={target} onClose={() => onEditing(null)} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button
          type="button"
          onClick={props.onBack}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white"
        >
          <ArrowLeft size={15} /> {t("common.myVehicles")}
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-2">
        <h1 className="text-[22px] font-semibold tracking-tight">{t("geofences.title")}</h1>
        {canManage && geofences.length > 0 && (
          <Button variant="signal" size="sm" onClick={() => start(null)}>
            <Plus size={15} strokeWidth={2.5} /> {t("geofences.new")}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {props.loading && (
          <div className="flex h-28 items-center justify-center text-white/50">
            <Spinner />
          </div>
        )}
        {!props.loading && geofences.length === 0 && (
          <div className="mx-2 mt-1 rounded-[16px] bg-ink-2 p-5">
            <p className="text-[17px] font-semibold leading-snug">{t("geofences.empty.title")}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-white/60">{t("geofences.empty.lead")}</p>
            {canManage ? (
              <Button variant="signal" className="mt-4" onClick={() => start(null)}>
                <Plus size={16} strokeWidth={2.5} /> {t("geofences.empty.create")}
              </Button>
            ) : (
              <p className="mt-3 text-sm text-white/45">{t("geofences.empty.notAllowed")}</p>
            )}
          </div>
        )}
        <ul className="space-y-1.5">
          {geofences.map((g) => {
            const Icon = SHAPE_ICON[g.geometry.shape];
            const can = editable(g);
            return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => (can ? start(g) : props.onShow(g))}
                  className={clsx("flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-ink-2", !g.active && "opacity-60")}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-white" style={{ background: colorOfGeofence(g) }}>
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{g.name}</span>
                    <span className="block truncate text-[13px] text-white/55">{summaryOf(g)}</span>
                  </span>
                  {g.inside > 0 && (
                    <span className="shrink-0 text-right">
                      <span className="num block text-[17px] font-semibold leading-none">{g.inside}</span>
                      <span className="text-[11px] text-white/45">{t("geofences.inside")}</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {geofences.length > 0 && (
          <button type="button" onClick={props.onEvents} className="mx-2 mt-4 text-[13px] font-semibold text-signal hover:underline">
            {t("geofences.showEvents")}
          </button>
        )}
      </div>
    </div>
  );
}

/** "Zona prohibida · lun a vie · apagada" */
function summaryOf(g: Geofence): string {
  const parts = [g.geometry.shape === "corridor" ? i18n.t("geofences.summary.corridor") : i18n.t(`shared.geofenceKind.${g.kind}`)];
  if (g.schedule) parts.push(isActive(g.schedule, Date.now()) ? i18n.t("geofences.summary.inSchedule") : i18n.t("geofences.summary.outOfSchedule"));
  if (g.vehicleIds !== null) parts.push(i18n.t("geofences.summary.vehicles", { count: g.vehicleIds.length }));
  else if (g.groupIds !== null) parts.push(i18n.t("geofences.summary.groups", { count: g.groupIds.length }));
  if (!g.active) parts.push(i18n.t("geofences.summary.off"));
  return parts.join(" · ");
}

// ─── Editor ──────────────────────────────────────────────────────────────────

export const label = "mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-white/45";
export const input =
  "h-10 w-full rounded-[10px] border-0 bg-ink-2 px-3 text-[15px] text-white placeholder:text-white/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal";
export const OFFICE_HOURS: WeekSchedule["days"] = [null, [480, 1080], [480, 1080], [480, 1080], [480, 1080], [480, 1080], null];

function Editor(props: Props & { editing: Editing; geofence: Geofence | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { geofence, editing, onEditing, groups } = props;
  const queryClient = useQueryClient();
  const draft = editing.draft;
  const [name, setName] = useState(geofence?.name ?? "");
  const [kind, setKind] = useState<GeofenceKind>(geofence?.kind ?? "notify");
  const [schedule, setSchedule] = useState<WeekSchedule | null>(geofence?.schedule ?? null);
  const [minStay, setMinStay] = useState(geofence?.minStayMin ? String(geofence.minStayMin) : "");
  const [maxStay, setMaxStay] = useState(geofence?.maxStayMin ? String(geofence.maxStayMin) : "");
  // Someone who only sees part of the account creates for what they see: their groups or, without any, their vehicles.
  const scoped = props.scope !== null;
  const myGroups = groups.filter((g) => !scoped || props.scope?.includes(g.id));
  const [groupIds, setGroupIds] = useState<string[] | null>(geofence ? geofence.groupIds : scoped && myGroups.length > 0 ? props.scope : null);
  const [vehicleIds, setVehicleIds] = useState<string[] | null>(geofence ? geofence.vehicleIds : scoped && myGroups.length === 0 ? [] : null);
  const target: "all" | "groups" | "vehicles" = vehicleIds !== null ? "vehicles" : groupIds !== null ? "groups" : "all";
  const [active, setActive] = useState(geofence?.active ?? true);
  const [confirming, setConfirming] = useState(false);

  const setDraft = (next: GeofenceDraft) => onEditing({ ...editing, draft: next });
  // The stroke color follows the selected type.
  const color = colorOf(kind, draft.shape);
  useEffect(() => {
    if (editing.color !== color) onEditing({ ...editing, color });
  }, [color, editing, onEditing]);

  const geometry = geometryOf(draft);
  const points = pointsOf(draft).length;
  const problem = geometry ? geometryProblem(geometry) : null;
  const minutes = (text: string) => (text.trim() === "" ? null : Number(text));
  const body: GeofenceInput | null =
    geometry && !problem && name.trim()
      ? { name: name.trim(), geometry, kind, schedule, minStayMin: minutes(minStay), maxStayMin: minutes(maxStay), groupIds, vehicleIds, active }
      : null;

  const save = useMutation({
    mutationFn: () => saveGeofence(body as GeofenceInput, geofence?.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
      props.onClose();
    },
  });
  const missing =
    points === 0
      ? t("geofences.editor.startDrawing")
      : !geometry
        ? t("geofences.editor.keepDrawing")
        : problem
          ? `${sayShared(problem)}.`
          : !name.trim()
            ? t("geofences.editor.needName")
            : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button
          type="button"
          onClick={props.onClose}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white"
        >
          <ArrowLeft size={15} /> {t("geofences.title")}
        </button>
      </div>

      <form
        className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-5 pb-5 pt-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (body) save.mutate();
        }}
      >
        <h1 className="text-[22px] font-semibold tracking-tight">{geofence ? t("geofences.editor.editTitle") : t("geofences.editor.newTitle")}</h1>

        <section>
          {!geofence && (
            <div className="flex gap-1 rounded-[10px] bg-ink-2 p-1" role="group" aria-label={t("geofences.editor.shape")}>
              {(["circle", "polygon", "corridor"] as const).map((shape) => {
                const Icon = SHAPE_ICON[shape];
                return (
                  <button
                    key={shape}
                    type="button"
                    aria-pressed={draft.shape === shape}
                    onClick={() => draft.shape !== shape && setDraft(emptyDraft(shape))}
                    className={clsx(
                      "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors",
                      draft.shape === shape ? "bg-white text-ink" : "text-white/65 hover:text-white",
                    )}
                  >
                    <Icon size={15} /> {t(`geofences.shape.${shape}`)}
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-sm leading-relaxed text-white/60">{t(`geofences.hint.${draft.shape}`)}</p>

          {draft.shape === "circle" && (
            <Meters
              label={t("geofences.editor.radius")}
              value={draft.radiusM}
              min={GEOFENCE_LIMITS.minRadiusM}
              max={GEOFENCE_LIMITS.maxRadiusM}
              onChange={(radiusM) => setDraft({ ...draft, radiusM: clampRadius(radiusM) })}
            />
          )}
          {draft.shape === "corridor" && (
            <Meters
              label={t("geofences.editor.width")}
              value={draft.widthM}
              min={GEOFENCE_LIMITS.minWidthM}
              max={GEOFENCE_LIMITS.maxWidthM}
              onChange={(widthM) => setDraft({ ...draft, widthM: Math.min(GEOFENCE_LIMITS.maxWidthM, Math.max(GEOFENCE_LIMITS.minWidthM, Math.round(widthM))) })}
            />
          )}
          {draft.shape !== "circle" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="num flex-1 whitespace-nowrap text-[13px] text-white/55">
                {t("geofences.editor.points", { count: points })}
              </span>
              <SmallButton onClick={() => setDraft(withoutLast(draft))} disabled={points === 0} icon={<Undo2 size={14} />}>
                {t("geofences.editor.undoLast")}
              </SmallButton>
              <SmallButton onClick={() => setDraft(emptyDraft(draft.shape))} disabled={points === 0} icon={<Trash2 size={14} />}>
                {t("geofences.editor.clear")}
              </SmallButton>
            </div>
          )}
        </section>

        <label className="block">
          <span className={label}>{t("common.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("geofences.editor.namePlaceholder")} className={input} />
        </label>

        {draft.shape !== "corridor" ? (
          <fieldset>
            <legend className={label}>{t("geofences.editor.kind")}</legend>
            <div className="space-y-1.5">
              {GEOFENCE_KINDS.map((k) => (
                <label
                  key={k}
                  className={clsx("flex cursor-pointer items-start gap-3 rounded-[12px] px-3 py-2.5 transition-colors", kind === k ? "bg-ink-3 ring-1 ring-white/25" : "bg-ink-2 hover:bg-ink-3")}
                >
                  <input type="radio" name="tipo" checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
                  <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(k, "circle") }} />
                  <span>
                    <span className="block text-sm font-semibold">{t(`shared.geofenceKind.${k}`)}</span>
                    <span className="block text-[13px] text-white/55">{t(`shared.geofenceKindNote.${k}`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="rounded-[12px] bg-ink-2 px-4 py-3 text-sm leading-relaxed text-white/60">{t("geofences.editor.corridorNote")}</p>
        )}

        <ScheduleEditor schedule={schedule} onChange={setSchedule} />

        <fieldset>
          <legend className={label}>{t("geofences.editor.stay")}</legend>
          <div className="grid grid-cols-2 gap-2">
            <Stay label={t("geofences.editor.stayLess")} value={minStay} onChange={setMinStay} />
            <Stay label={t("geofences.editor.stayMore")} value={maxStay} onChange={setMaxStay} />
          </div>
        </fieldset>

        <fieldset>
          <legend className={label}>{t("geofences.editor.appliesTo")}</legend>
          <div className="mb-2 flex gap-1 rounded-[10px] bg-ink-2 p-1">
            {!scoped && (
              <Segment
                active={target === "all"}
                onClick={() => {
                  setGroupIds(null);
                  setVehicleIds(null);
                }}
              >
                {t("common.all")}
              </Segment>
            )}
            {myGroups.length > 0 && (
              <Segment
                active={target === "groups"}
                onClick={() => {
                  setVehicleIds(null);
                  setGroupIds(groupIds ?? []);
                }}
              >
                {t("common.groups")}
              </Segment>
            )}
            <Segment
              active={target === "vehicles"}
              onClick={() => {
                setGroupIds(null);
                setVehicleIds(vehicleIds ?? []);
              }}
            >
              {t("common.vehicles")}
            </Segment>
          </div>
          {target === "groups" && <Checks items={myGroups.map((g) => ({ id: g.id, name: g.name, note: String(g.vehicleCount) }))} chosen={groupIds ?? []} onChange={setGroupIds} empty={t("geofences.editor.noGroups")} />}
          {target === "vehicles" && (
            <Checks items={props.vehicles.map((v) => ({ id: v.id, name: v.name, note: v.plate ?? "" }))} chosen={vehicleIds ?? []} onChange={setVehicleIds} empty={t("geofences.editor.noVehicles")} />
          )}
        </fieldset>

        {geofence && (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-signal" />
            {t("geofences.editor.active")}
          </label>
        )}

        {save.isError && <p className="rounded-[12px] bg-danger/20 px-4 py-3 text-sm text-blush">{errorText(save.error)}</p>}
        {missing && <p className="text-[13px] text-white/50">{missing}</p>}

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="signal"
            loading={save.isPending}
            disabled={!body || (groupIds !== null && groupIds.length === 0) || (vehicleIds !== null && vehicleIds.length === 0) || (schedule !== null && schedule.days.every((d) => d === null))}
            className="flex-1"
          >
            {geofence ? t("geofences.editor.save") : t("geofences.editor.create")}
          </Button>
          <button type="button" onClick={props.onClose} className="h-10 rounded-[10px] px-4 text-sm font-semibold text-white/70 hover:bg-ink-2 hover:text-white">
            {t("common.cancel")}
          </button>
        </div>
        {geofence && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-coral hover:bg-ink-2"
          >
            <Trash2 size={15} /> {t("geofences.editor.delete")}
          </button>
        )}
      </form>

      {geofence && (
        <ConfirmDialog
          open={confirming}
          title={t("geofences.remove.title")}
          confirm={t("geofences.remove.confirm")}
          onClose={() => setConfirming(false)}
          action={async () => {
            await deleteGeofence(geofence.id);
            await queryClient.invalidateQueries({ queryKey: ["geofences"] });
          }}
          onDone={props.onClose}
        >
          <Trans i18nKey="geofences.remove.body" values={{ name: geofence.name }} components={{ b: <strong className="font-semibold" /> }} />
        </ConfirmDialog>
      )}
    </div>
  );
}

/** A list of things to tick, for choosing groups or vehicles. */
export function Checks({ items, chosen, onChange, empty }: { items: { id: string; name: string; note?: string }[]; chosen: string[]; onChange: (ids: string[]) => void; empty: string }) {
  const { t } = useTranslation();
  if (items.length === 0) return <p className="px-2 text-[13px] text-white/50">{empty}</p>;
  return (
    <div className="max-h-52 space-y-0.5 overflow-y-auto">
      {items.map((item) => (
        <label key={item.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-2">
          <input
            type="checkbox"
            checked={chosen.includes(item.id)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, item.id] : chosen.filter((id) => id !== item.id))}
            className="h-4 w-4 accent-signal"
          />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          {item.note && <span className="num text-[12px] text-white/45">{item.note}</span>}
        </label>
      ))}
      {chosen.length === 0 && <p className="px-2 pt-1 text-[13px] text-apricot">{t("geofences.pickOne")}</p>}
    </div>
  );
}

export function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx("h-8 flex-1 rounded-lg text-[13px] font-medium transition-colors", active ? "bg-white text-ink" : "text-white/65 hover:text-white")}
    >
      {children}
    </button>
  );
}

function SmallButton({ onClick, disabled, icon, children }: { onClick: () => void; disabled: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink-2 px-2.5 text-[12.5px] font-medium text-white/75 hover:bg-ink-3 hover:text-white disabled:opacity-40"
    >
      {icon} {children}
    </button>
  );
}

/** Meters field that allows free typing and applies the value on leaving. */
function Meters({ label: text, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [typed, setTyped] = useState(String(value));
  useEffect(() => setTyped(String(value)), [value]);
  const apply = () => {
    const n = Number(typed);
    if (Number.isFinite(n) && n > 0) onChange(n);
    else setTyped(String(value));
  };
  return (
    <label className="mt-3 flex items-center gap-3">
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
        className="num h-10 w-28 shrink-0 rounded-[10px] border-0 bg-ink-2 px-3 text-right text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      />
      <span className="w-4 text-sm text-white/50">m</span>
    </label>
  );
}

function Stay({ label: text, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block rounded-[12px] bg-ink-2 px-3 py-2.5">
      <span className="block text-[12.5px] leading-snug text-white/60">{text}</span>
      <span className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="—"
          className="num h-8 w-full rounded-lg border-0 bg-ink px-2 text-right text-sm text-white placeholder:text-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        />
        <span className="text-[13px] text-white/50">min</span>
      </span>
    </label>
  );
}

// ─── Schedule ─────────────────────────────────────────────────────────────────

/** Hours in quarter-hour steps, always in 24-hour format and in little space. */
const QUARTERS = Array.from({ length: 96 }, (_, i) => i * 15);

function TimeSelect({ label: text, value, onChange }: { label: string; value: number; onChange: (minute: number) => void }) {
  const options = QUARTERS.includes(value % 1440) ? QUARTERS : [...QUARTERS, value % 1440].sort((a, b) => a - b);
  return (
    <select
      aria-label={text}
      value={value % 1440}
      onChange={(e) => onChange(Number(e.target.value))}
      className="num h-8 rounded-lg border-0 bg-ink px-1.5 text-[13px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      {options.map((minute) => (
        <option key={minute} value={minute}>
          {minuteLabel(minute)}
        </option>
      ))}
    </select>
  );
}

/** Weekly schedule. With `required` "always" cannot be chosen: a schedule is needed. */
export function ScheduleEditor({
  schedule,
  onChange,
  title,
  required = false,
}: {
  schedule: WeekSchedule | null;
  onChange: (schedule: WeekSchedule | null) => void;
  title?: string;
  required?: boolean;
}) {
  const { t } = useTranslation();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const setDay = (day: number, window: [number, number] | null) => {
    if (!schedule) return;
    onChange({ ...schedule, days: schedule.days.map((d, i) => (i === day ? window : d)) });
  };
  // The week is shown from Monday to Sunday.
  const order = [1, 2, 3, 4, 5, 6, 0] as const;
  return (
    <fieldset>
      <legend className={label}>{title ?? t("geofences.schedule.title")}</legend>
      {!required && (
        <div className="flex gap-1 rounded-[10px] bg-ink-2 p-1">
          <Segment active={schedule === null} onClick={() => onChange(null)}>
            {t("geofences.schedule.always")}
          </Segment>
          <Segment active={schedule !== null} onClick={() => onChange(schedule ?? { zone, days: OFFICE_HOURS })}>
            {t("geofences.schedule.onSchedule")}
          </Segment>
        </div>
      )}
      {schedule && (
        <div className="mt-2 space-y-1">
          {order.map((day) => {
            const window = schedule.days[day] ?? null;
            const dayName = t(`shared.weekday.${WEEKDAY_KEYS[day]}`);
            return (
              <div key={day} className="flex h-10 items-center gap-2 rounded-lg px-2 hover:bg-ink-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
                  <input type="checkbox" checked={window !== null} onChange={(e) => setDay(day, e.target.checked ? [480, 1080] : null)} className="h-4 w-4 accent-signal" />
                  <span className={clsx(window === null && "text-white/45")}>{dayName}</span>
                </label>
                {window && (
                  <>
                    <TimeSelect label={t("geofences.schedule.from", { day: dayName })} value={window[0]} onChange={(from) => setDay(day, [from, window[1]])} />
                    <span className="text-white/40">{t("geofences.schedule.until")}</span>
                    <TimeSelect label={t("geofences.schedule.to", { day: dayName })} value={window[1]} onChange={(to) => setDay(day, [window[0], to])} />
                  </>
                )}
              </div>
            );
          })}
          <p className="px-2 pt-1 text-[12px] leading-relaxed text-white/45">
            {t("geofences.schedule.zoneNote", { zone: schedule.zone.replace(/_/g, " ") })}
            {schedule.days.every((d) => d === null) && <span className="text-apricot"> {t("geofences.schedule.needDay")}</span>}
          </p>
        </div>
      )}
    </fieldset>
  );
}
