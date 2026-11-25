// Report and dashboard charts: bars per day (one series or two
// stacked) and horizontal bars for rankings.
//
// A single series is in ink; movement and idling use the same colors
// as on the map, with a gap between the two segments. Exact values
// appear on hover, on tap or when reached with the keyboard.
import clsx from "clsx";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { currentLanguage } from "../../lib/i18n";
import { formatDate, formatDateShort } from "./kit";

export interface Series {
  name: string;
  /** Fill color, in CSS. */
  color: string;
  values: number[];
}

export const INK = "var(--color-ink-3)";
export const MOVING = "var(--color-moving)";
export const IDLE = "var(--color-idle)";

/** Round cap for the axis: 1, 2, 2.5 or 5 times a power of ten, in the displayed unit. */
function niceTop(value: number, unit: number): number {
  const shown = value / unit;
  if (shown <= 0) return unit;
  const power = 10 ** Math.floor(Math.log10(shown));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= shown) ?? 10;
  return step * power * unit;
}

const short = new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 1 });
/** Axis values, without extra decimals: "250 km", "2,5 h", "30 min". */
export const axisKm = (meters: number) => `${short.format(meters / 1000)} km`;
export const axisTime = (seconds: number) => (seconds >= 3600 ? `${short.format(seconds / 3600)} h` : `${short.format(seconds / 60)} min`);
export const axisCount = (value: number) => short.format(value);

/** Axis labels written at most, so they do not overlap on a phone. */
const MAX_TICKS = 8;

export function BarChart({
  labels,
  dates,
  series,
  format,
  axis,
  unit = 1,
  height = 190,
}: {
  labels: string[];
  /** The labels are days ("2026-11-21"). */
  dates: boolean;
  series: Series[];
  format: (value: number) => string;
  /** How the axis values, which are round, are written; if missing, same as the others. */
  axis?: (value: number) => string;
  /** How much one displayed unit is worth: 1000 if values are in meters and read in kilometers. */
  unit?: number;
  height?: number;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);
  const totals = labels.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const max = Math.max(0, ...totals);
  if (labels.length === 0 || max <= 0) return <p className="flex items-center justify-center text-sm text-muted" style={{ height }}>{t("reports.noData")}</p>;
  const top = niceTop(max, unit);
  const every = Math.ceil(labels.length / MAX_TICKS);
  const name = (label: string) => (dates ? formatDate(label) : label);
  const stacked = series.length > 1;

  return (
    <figure className="m-0">
      {stacked && (
        <figcaption className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </figcaption>
      )}
      <div className="relative" style={{ height }} onMouseLeave={() => setActive(null)}>
        {[1, 0.5].map((share) => (
          <div key={share} className="pointer-events-none absolute inset-x-0 border-t border-line" style={{ bottom: `${share * 100}%` }}>
            <span className="absolute left-0 top-0.5 text-[10.5px] leading-none text-muted">{(axis ?? format)(top * share)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end border-b border-faint pl-14">
          {labels.map((label, i) => {
            const total = totals[i] as number;
            const parts = series.filter((s) => (s.values[i] ?? 0) > 0);
            return (
              <div
                key={label}
                role="img"
                tabIndex={0}
                aria-label={`${name(label)}: ${stacked ? series.map((s) => `${s.name} ${format(s.values[i] ?? 0)}`).join(", ") : format(total)}`}
                className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center outline-none focus-visible:bg-ink/[0.04]"
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onClick={() => setActive(i)}
              >
                <div
                  className={clsx("flex w-[64%] min-w-[3px] max-w-[30px] flex-col-reverse gap-[2px] transition-opacity", active !== null && active !== i && "opacity-45")}
                  style={{ height: `${(total / top) * 100}%` }}
                >
                  {parts.map((s, n) => (
                    <div key={s.name} className={clsx("min-h-[1px] w-full", n === parts.length - 1 && "rounded-t-[4px]")} style={{ flexGrow: s.values[i] ?? 0, flexBasis: 0, background: s.color }} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {active !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max max-w-[220px] rounded-[10px] bg-panel px-3 py-2 text-[12.5px] text-white shadow-lg"
            style={tooltipPlace(active, labels.length)}
          >
            <p className="font-semibold">{name(labels[active] as string)}</p>
            {stacked ? (
              <>
                {series.map((s) => (
                  <p key={s.name} className="mt-0.5 flex items-center justify-between gap-4 text-white/80">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
                      {s.name}
                    </span>
                    <span className="num text-white">{format(s.values[active] ?? 0)}</span>
                  </p>
                ))}
              </>
            ) : (
              <p className="num mt-0.5">{format(totals[active] as number)}</p>
            )}
          </div>
        )}
      </div>
      <div className="flex pl-14 pt-1.5" aria-hidden="true">
        {labels.map((label, i) => (
          <span key={label} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[10.5px] leading-none text-muted">
            {i % every === 0 ? (dates ? formatDateShort(label) : label) : ""}
          </span>
        ))}
      </div>
    </figure>
  );
}

/** The box with the value goes over its bar, without overflowing the sides. */
function tooltipPlace(index: number, count: number): React.CSSProperties {
  // 3.5rem is the space taken by the axis values on the left.
  const center = `calc(3.5rem + (100% - 3.5rem) * ${(index + 0.5) / count})`;
  const share = (index + 0.5) / count;
  if (share < 0.25) return { left: center, transform: "translateX(-12px)" };
  if (share > 0.75) return { left: center, transform: "translateX(calc(-100% + 12px))" };
  return { left: center, transform: "translateX(-50%)" };
}

/** Ranking with horizontal bars: name, bar and value on each row. */
export function HBars({ rows, format, empty }: { rows: { key: string; label: string; value: number }[]; format: (value: number) => string; empty?: string }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty ?? t("reports.noData")}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,36%)_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
          <span className="truncate text-ink-3" title={r.label}>
            {r.label}
          </span>
          <span className="h-2.5 overflow-hidden rounded-[4px] bg-canvas">
            <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100)}%`, background: INK }} />
          </span>
          <span className="num text-right text-ink">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
