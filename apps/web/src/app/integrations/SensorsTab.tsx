// Sensors that are not a GPS: a temperature probe, a door, a
// scale. Each one sends its readings over HTTP with its own key.
import { SENSOR_KINDS, SENSOR_UNIT, type Sensor, type SensorInput, type SensorKind } from "@opengps/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, RefreshCw, Thermometer, Trash } from "lucide-react";
import { type FormEvent, type PointerEvent, useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { formatDateTime, timeAgo } from "../../lib/format";
import { currentLanguage } from "../../lib/i18n";
import { apiBase, createSensor, deleteSensor, getSensorSeries, getSensors, rotateSensorKey, updateSensor } from "../../lib/integrations";
import { useNow } from "../../lib/session";
import { amountOf } from "../fleet/format";
import { Card, Segmented } from "../reports/kit";
import { errorText } from "../widgets";
import { Code, SecretBox, label, select } from "./kit";

const shown = (value: number, unit: string | null) => `${new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ""}`;
const badge = "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold";
const example = (secret: string) => `curl -X POST ${apiBase()}/sensors/readings \\\n  -H "Authorization: Bearer ${secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"value": 4.5}'`;

export function SensorsTab({ vehicles, canManage }: { vehicles: { id: string; name: string }[]; canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const sensors = useQuery({ queryKey: ["integrations", "sensors"], queryFn: getSensors, refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Sensor | "new" | null>(null);
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  return (
    <div className="space-y-4">
      <Card
        title={t("integrations.sensors.title")}
        note={t("integrations.sensors.note")}
        action={
          canManage ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden="true" /> {t("integrations.sensors.new")}
            </Button>
          ) : undefined
        }
      >
        {fresh && (
          <div className="mb-4">
            <SecretBox title={t("integrations.sensors.keyTitle", { name: fresh.name })} secret={fresh.secret}>
              <p className="text-[13px] leading-relaxed text-ink-3">{t("integrations.sensors.keyNote")}</p>
              <Code>{example(fresh.secret)}</Code>
            </SecretBox>
          </div>
        )}
        {sensors.isLoading && <Spinner className="text-muted" />}
        {sensors.isError && <Notice tone="error">{errorText(sensors.error)}</Notice>}
        {sensors.data &&
          (sensors.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">{t("integrations.sensors.empty")}{canManage && ` ${t("integrations.sensors.emptyHint")}`}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {sensors.data.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setEditing(s)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                    <Thermometer size={18} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">{s.name}</span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {t(`shared.sensorKind.${s.kind}`)}
                        {s.vehicleName && ` · ${s.vehicleName}`}
                        {s.lastAt && ` · ${timeAgo(s.lastAt, now)}`}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="num text-[15px] font-semibold text-ink">{s.lastValue === null ? "—" : shown(s.lastValue, s.unit)}</span>
                      {s.lastValue === null ? (
                        <span className={clsx(badge, "border border-line bg-canvas text-muted")}>{t("integrations.sensors.noReadings")}</span>
                      ) : s.alerting ? (
                        <span className={clsx(badge, "bg-danger/10 text-danger")}>{t("integrations.sensors.outOfRange")}</span>
                      ) : (
                        <span className={clsx(badge, "bg-moving/10 text-signal-ink")}>{t("integrations.sensors.inRange")}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>
      {editing && (
        <SensorDialog
          sensor={editing === "new" ? null : editing}
          vehicles={vehicles}
          canManage={canManage}
          onClose={() => setEditing(null)}
          onSaved={(next, secret, name) => {
            queryClient.setQueryData(["integrations", "sensors"], next);
            if (secret) setFresh({ name, secret });
          }}
          onSecret={(name, secret) => setFresh({ name, secret })}
        />
      )}
    </div>
  );
}

function SensorDialog({ sensor, vehicles, canManage, onClose, onSaved, onSecret }: { sensor: Sensor | null; vehicles: { id: string; name: string }[]; canManage: boolean; onClose: () => void; onSaved: (next: Sensor[], secret: string | null, name: string) => void; onSecret: (name: string, secret: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const text = (n: number | null) => (n === null ? "" : String(n));
  const [name, setName] = useState(sensor?.name ?? "");
  const [kind, setKind] = useState<SensorKind>(sensor?.kind ?? "temperature");
  const [unit, setUnit] = useState(sensor ? (sensor.unit ?? "") : SENSOR_UNIT.temperature);
  const [vehicleId, setVehicleId] = useState(sensor?.vehicleId ?? "");
  const [min, setMin] = useState(text(sensor?.minValue ?? null));
  const [max, setMax] = useState(text(sensor?.maxValue ?? null));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (body: SensorInput) => (sensor ? { sensors: await updateSensor(sensor.id, body), secret: null } : createSensor(body)),
    onSuccess: (r) => {
      onSaved(r.sensors, r.secret, name.trim());
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteSensor(sensor?.id ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations", "sensors"] });
      onClose();
    },
  });
  const rotate = useMutation({
    mutationFn: () => rotateSensorKey(sensor?.id ?? ""),
    onSuccess: (secret) => {
      void queryClient.invalidateQueries({ queryKey: ["integrations", "sensors"] });
      onSecret(sensor?.name ?? "", secret);
      onClose();
    },
  });
  // A signed number with decimals, as typed: "-18,5".
  const numberOf = (value: string) => (value.trim() === "" ? null : value.trim().startsWith("-") ? -(amountOf(value.trim().slice(1)) ?? Number.NaN) : amountOf(value));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const minValue = numberOf(min);
    const maxValue = numberOf(max);
    if (!name.trim()) return setProblem(t("integrations.sensors.dialog.needName"));
    if ([minValue, maxValue].some((n) => n !== null && Number.isNaN(n))) return setProblem(t("integrations.sensors.dialog.notNumbers"));
    if (minValue !== null && maxValue !== null && minValue >= maxValue) return setProblem(t("integrations.sensors.dialog.minBelowMax"));
    setProblem(null);
    save.mutate({ name: name.trim(), kind, unit: unit.trim() || null, vehicleId: vehicleId || null, minValue, maxValue });
  };
  return (
    <Modal open onClose={onClose} title={sensor ? sensor.name : t("integrations.sensors.new")} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {sensor && <SensorChart sensor={sensor} />}
        <fieldset disabled={!canManage} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.6fr_1fr]">
            <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("integrations.sensors.dialog.namePlaceholder")} autoFocus={!sensor} />
            <div>
              <label htmlFor="sensor-clase" className={label}>
                {t("integrations.sensors.dialog.kind")}
              </label>
              <select
                id="sensor-clase"
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as SensorKind;
                  // The unit changes with the class only if it was still the proposed one.
                  if (unit === SENSOR_UNIT[kind]) setUnit(SENSOR_UNIT[next]);
                  setKind(next);
                }}
                className={select}
              >
                {SENSOR_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`shared.sensorKind.${k}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="sensor-vehiculo" className={label}>
              {t("integrations.sensors.dialog.vehicle")}
            </label>
            <select id="sensor-vehiculo" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={select}>
              <option value="">{t("integrations.sensors.dialog.noVehicle")}</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{t("integrations.sensors.dialog.vehicleNote")}</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t("integrations.sensors.dialog.min")} value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" mono />
            <Field label={t("integrations.sensors.dialog.max")} value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" mono />
            <Field label={t("integrations.sensors.dialog.unit")} value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={12} />
          </div>
        </fieldset>
        {sensor && canManage && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-canvas px-4 py-3 text-[13px] text-ink-3">
            <span>
              <Trans i18nKey="integrations.sensors.dialog.keyPrefix" values={{ prefix: sensor.keyPrefix }} components={{ k: <span className="num text-ink" /> }} />
            </span>
            <Button type="button" variant="secondary" size="sm" loading={rotate.isPending} onClick={() => rotate.mutate()} title={t("integrations.sensors.dialog.rotateTitle")}>
              <RefreshCw size={14} aria-hidden="true" /> {t("integrations.sensors.dialog.rotate")}
            </Button>
          </div>
        )}
        {(problem || save.isError || remove.isError || rotate.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error ?? rotate.error)}</Notice>}
        {canManage ? (
          <div className="flex items-center justify-between gap-2">
            {sensor ? (
              <Button type="button" variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate()} title={t("integrations.sensors.dialog.deleteTitle")}>
                <Trash size={14} aria-hidden="true" /> {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={save.isPending}>
                {t("common.save")}
              </Button>
            </span>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}

// ─── Chart ─────────────────────────────────────────────────────────────────

const SPANS = [
  { id: "24h", label: "integrations.sensors.chart.span.h24", ms: 86_400_000 },
  { id: "7d", label: "integrations.sensors.chart.span.d7", ms: 7 * 86_400_000 },
  { id: "30d", label: "integrations.sensors.chart.span.d30", ms: 30 * 86_400_000 },
] as const;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 46 };

/** The readings of a period, with the lines of their minimum and maximum. */
function SensorChart({ sensor }: { sensor: Sensor }) {
  const { t } = useTranslation();
  const [span, setSpan] = useState<(typeof SPANS)[number]["id"]>("24h");
  const ms = SPANS.find((s) => s.id === span)?.ms ?? 86_400_000;
  // The period is fixed when chosen: otherwise each clock tick would request the readings again.
  const range = useMemo(() => {
    const to = Date.now();
    return { from: new Date(to - ms), to: new Date(to + 60_000) };
  }, [ms]);
  const series = useQuery({ queryKey: ["integrations", "series", sensor.id, span], queryFn: () => getSensorSeries(sensor.id, range.from, range.to), placeholderData: keepPreviousData });
  const [hover, setHover] = useState<number | null>(null);
  // The chart is drawn at the real width of its box: so its text reads the same on a phone.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [W, setW] = useState(580);
  useEffect(() => {
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => entry && setW(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);
  const points = series.data?.points ?? [];
  const limits = [sensor.minValue, sensor.maxValue].filter((n): n is number => n !== null);
  const values = [...points.map((p) => p[1]), ...limits];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const margin = (high - low || 1) * 0.12;
  const y0 = low - margin;
  const y1 = high + margin;
  const x = (time: number) => PAD.left + ((time - range.from.getTime()) / (range.to.getTime() - range.from.getTime())) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const time = range.from.getTime() + (((e.clientX - box.left) / box.width) * W - PAD.left) / (W - PAD.left - PAD.right) * (range.to.getTime() - range.from.getTime());
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs((points[i] as [number, number])[0] - time) < Math.abs((points[best] as [number, number])[0] - time)) best = i;
    setHover(best);
  };
  const at = hover !== null ? points[hover] : undefined;
  // The last reading is the one the server just brought: the one in the list can be half a minute old.
  const last = series.data?.sensor.lastValue ?? sensor.lastValue;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-ink-3" aria-live="polite">
          {at ? (
            <>
              <span className="num font-semibold text-ink">{shown(at[1], sensor.unit)}</span> · <span className="num">{formatDateTime(new Date(at[0]).toISOString())}</span>
            </>
          ) : last !== null ? (
            <>
              {t("integrations.sensors.chart.last")} <span className="num font-semibold text-ink">{shown(last, sensor.unit)}</span>
            </>
          ) : (
            t("integrations.sensors.chart.never")
          )}
        </p>
        <Segmented label={t("integrations.period")} options={SPANS.map((s) => ({ id: s.id, label: t(s.label) }))} value={span} onChange={setSpan} />
      </div>
      <div ref={setFrame} className="rounded-[12px] border border-line bg-surface p-2">
        {points.length === 0 ? (
          <p className="flex h-[150px] items-center justify-center text-[13px] text-muted">{series.isLoading ? t("common.loading") : t("integrations.sensors.chart.empty")}</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block touch-none" role="img" aria-label={t("integrations.sensors.chart.label", { name: sensor.name, min: shown(Math.min(...points.map((p) => p[1])), sensor.unit), max: shown(Math.max(...points.map((p) => p[1])), sensor.unit) })} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {[y1 - margin, (y0 + y1) / 2, y0 + margin].map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeWidth="1" />
                <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="num" fontSize="11" fill="var(--color-muted)">
                  {new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 1 }).format(v)}
                </text>
              </g>
            ))}
            {limits.map((v) => (
              <line key={`l${v}`} x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-danger)" strokeWidth="1.5" strokeDasharray="5 4" />
            ))}
            <path d={path} fill="none" stroke="var(--color-ink-3)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {points.length === 1 && <circle cx={x((points[0] as [number, number])[0])} cy={y((points[0] as [number, number])[1])} r="4" fill="var(--color-ink-3)" />}
            {at && (
              <>
                <line x1={x(at[0])} x2={x(at[0])} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-faint)" strokeWidth="1" />
                <circle cx={x(at[0])} cy={y(at[1])} r="4.5" fill="var(--color-ink)" stroke="#ffffff" strokeWidth="2" />
              </>
            )}
            <text x={PAD.left} y={H - 5} className="num" fontSize="11" fill="var(--color-muted)">
              {formatDateTime(range.from.toISOString())}
            </text>
            <text x={W - PAD.right} y={H - 5} textAnchor="end" className="num" fontSize="11" fill="var(--color-muted)">
              {t("integrations.sensors.chart.now")}
            </text>
          </svg>
        )}
      </div>
      {limits.length > 0 && points.length > 0 && <p className="text-[12px] text-muted">{t("integrations.sensors.chart.limitNote")}</p>}
    </section>
  );
}
