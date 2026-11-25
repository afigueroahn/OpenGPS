// The stops of a route or a dispatch, in order: they are added from
// points of interest or by tapping the map, renamed, reordered and removed.
import type { Poi } from "@opengps/shared";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface StopDraft {
  key: number;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  /** Minutes since departure and of stay, as typed. Only on planned routes. */
  etaMin: string;
  stayMin: string;
  contact: string;
}

let nextKey = 1;
export const newStop = (point: { lat: number; lon: number }, name: string, extra: Partial<StopDraft> = {}): StopDraft => ({ key: nextKey++, name, lat: point.lat, lon: point.lon, radiusM: 100, etaMin: "", stayMin: "", contact: "", ...extra });
export const stopFromPoi = (poi: Poi): StopDraft => newStop(poi, poi.name, { radiusM: poi.radiusM });

// Without width: each field sets its own, so two widths do not clash.
const small = "h-9 min-w-0 rounded-[9px] border border-line bg-surface px-2.5 text-[13.5px] text-ink placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";

export function StopsEditor(props: { stops: StopDraft[]; onChange: (stops: StopDraft[]) => void; pois: Poi[]; /** With a schedule: minutes from departure and of stay. Without it: who receives the delivery. */ schedule: boolean }) {
  const { t } = useTranslation();
  const { stops, onChange } = props;
  const patch = (key: number, change: Partial<StopDraft>) => onChange(stops.map((s) => (s.key === key ? { ...s, ...change } : s)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...stops];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item as StopDraft);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {stops.length === 0 ? (
        <p className="rounded-[10px] bg-canvas px-3 py-2.5 text-[13px] text-ink-3">{t("routes.stops.empty")}</p>
      ) : (
        <ol className="space-y-1.5">
          {stops.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11.5px] font-semibold text-on-primary">{i + 1}</span>
              <input aria-label={t("routes.stops.name", { n: i + 1 })} value={s.name} onChange={(e) => patch(s.key, { name: e.target.value })} maxLength={80} className={`${small} flex-1`} />
              {props.schedule ? (
                <>
                  <input aria-label={t("routes.stops.eta", { n: i + 1 })} value={s.etaMin} onChange={(e) => patch(s.key, { etaMin: e.target.value })} inputMode="numeric" placeholder="min" title={t("routes.stops.etaTitle")} className={`${small} num w-14 shrink-0 text-right`} />
                  <input aria-label={t("routes.stops.stay", { n: i + 1 })} value={s.stayMin} onChange={(e) => patch(s.key, { stayMin: e.target.value })} inputMode="numeric" placeholder={t("routes.stops.stayPlaceholder")} title={t("routes.stops.stayTitle")} className={`${small} num hidden w-14 shrink-0 text-right sm:block`} />
                </>
              ) : (
                <input aria-label={t("routes.stops.contact", { n: i + 1 })} value={s.contact} onChange={(e) => patch(s.key, { contact: e.target.value })} maxLength={80} placeholder={t("routes.stops.contactPlaceholder")} className={`${small} hidden w-36 shrink-0 sm:block`} />
              )}
              <input
                aria-label={t("routes.stops.radius", { n: i + 1 })}
                value={String(s.radiusM)}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ""));
                  patch(s.key, { radiusM: Math.min(2000, n) });
                }}
                onBlur={() => s.radiusM < 20 && patch(s.key, { radiusM: 20 })}
                inputMode="numeric"
                title={t("routes.stops.radiusTitle")}
                className={`${small} num hidden w-[4.2rem] shrink-0 text-right sm:block`}
              />
              <span className="flex shrink-0">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("routes.stops.up", { n: i + 1 })} className="rounded-md p-1 text-muted hover:bg-canvas hover:text-ink disabled:opacity-30">
                  <ChevronUp size={15} />
                </button>
                <button type="button" disabled={i === stops.length - 1} onClick={() => move(i, 1)} aria-label={t("routes.stops.down", { n: i + 1 })} className="rounded-md p-1 text-muted hover:bg-canvas hover:text-ink disabled:opacity-30">
                  <ChevronDown size={15} />
                </button>
                <button type="button" onClick={() => onChange(stops.filter((x) => x.key !== s.key))} aria-label={t("routes.stops.remove", { n: i + 1 })} className="rounded-md p-1 text-muted hover:bg-canvas hover:text-danger">
                  <X size={15} />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {props.pois.length > 0 && (
        <select
          aria-label={t("routes.stops.addPoi")}
          value=""
          onChange={(e) => {
            const poi = props.pois.find((p) => p.id === e.target.value);
            if (poi) onChange([...stops, stopFromPoi(poi)]);
          }}
          className="h-9 w-full max-w-[280px] rounded-[9px] border border-line bg-surface px-2.5 text-[13px] text-ink"
        >
          <option value="">{t("routes.stops.addPoiOption")}</option>
          {props.pois.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
