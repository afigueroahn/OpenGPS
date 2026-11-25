// Public delivery page: whoever is waiting for it sees how it is going and, while the
// vehicle is on its way, where it is. It does not ask for an account. The link key goes
// after the hash of the URL, so the browser never sends it when
// requesting the page.
import type { DeliveryView } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RouteMap } from "../app/routes/RouteMap";
import { Logo, Spinner } from "../components/ui";
import { ApiRequestError } from "../lib/api";
import { formatDateTime, timeAgo } from "../lib/format";
import i18n from "../lib/i18n";
import { viewDelivery } from "../lib/routes";
import { useNow } from "../lib/session";

const REFRESH_MS = 10_000;

/** Which step the delivery is at, and how to say it. */
function stageOf(view: DeliveryView): { step: number; title: string; text: string } {
  if (view.status === "done") return { step: 3, title: i18n.t("pages.delivery.done"), text: view.doneAt ? i18n.t("pages.delivery.doneAt", { date: formatDateTime(view.doneAt) }) : "" };
  if (view.status === "failed") return { step: -1, title: i18n.t("pages.delivery.failed"), text: i18n.t("pages.delivery.failedText") };
  if (view.status === "skipped" || view.tripStatus === "cancelled") return { step: -1, title: i18n.t("pages.delivery.rescheduled"), text: i18n.t("pages.delivery.rescheduledText") };
  if (view.status === "arrived") return { step: 2, title: i18n.t("pages.delivery.arrived"), text: view.arrivedAt ? i18n.t("pages.delivery.arrivedAt", { date: formatDateTime(view.arrivedAt) }) : "" };
  if (view.tripStatus === "in_progress") {
    const before = view.stopsBefore;
    return { step: 1, title: i18n.t("pages.delivery.onTheWay"), text: before === 0 ? i18n.t("pages.delivery.yoursIsNext") : i18n.t("pages.delivery.stopsBefore", { count: before }) };
  }
  return { step: 0, title: i18n.t("pages.delivery.scheduled"), text: view.plannedAt ? i18n.t("pages.delivery.plannedFor", { date: formatDateTime(view.plannedAt) }) : i18n.t("pages.delivery.notLeft") };
}
const STEPS = ["pages.delivery.steps.scheduled", "pages.delivery.steps.onTheWay", "pages.delivery.steps.arrived", "pages.delivery.steps.delivered"] as const;

export function DeliveryPage() {
  const [token] = useState(() => window.location.hash.slice(1));
  const now = useNow();
  const { t } = useTranslation();
  const delivery = useQuery({ queryKey: ["delivery", token], queryFn: () => viewDelivery(token), enabled: token.length >= 20, refetchInterval: REFRESH_MS, retry: (count, err) => !(err instanceof ApiRequestError && err.status === 404) && count < 2 });
  const view = delivery.data;
  const gone = token.length < 20 || (delivery.isError && !view);
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <Logo />
        {view && <span className="truncate text-sm text-muted">{view.account}</span>}
      </header>
      <main className="mx-auto w-full max-w-[560px] flex-1 space-y-3.5 px-4 py-4">
        {gone ? (
          <div className="rounded-[18px] bg-surface p-7 text-center shadow-[0_2px_6px_rgb(16_22_35/0.08)]">
            <h1 className="text-[19px] font-semibold tracking-tight">{t("pages.linkGone.title")}</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-3">{t("pages.linkGone.askNew")}</p>
          </div>
        ) : !view ? (
          <div className="flex h-40 items-center justify-center text-muted">
            <Spinner size={24} />
          </div>
        ) : (
          <Tracking view={view} now={now} />
        )}
      </main>
    </div>
  );
}

function Tracking({ view, now }: { view: DeliveryView; now: number }) {
  const stage = stageOf(view);
  const { t } = useTranslation();
  return (
    <>
      <section className="rounded-[16px] bg-surface px-5 py-4 shadow-[0_1px_3px_rgb(16_22_35/0.08)]">
        <p className="text-[12.5px] font-medium uppercase tracking-wider text-muted">{t("pages.delivery.yourDelivery", { stop: view.stopName })}</p>
        <h1 className={clsx("mt-1 text-[24px] font-semibold leading-tight tracking-tight", stage.step === -1 ? "text-danger" : "text-ink")}>{stage.title}</h1>
        {stage.text && <p className="mt-1 text-[15px] leading-relaxed text-ink-3">{stage.text}</p>}
        {stage.step >= 0 && (
          <ol className="mt-4 grid grid-cols-4 gap-1.5" aria-label={t("pages.delivery.stepsLabel")}>
            {STEPS.map((name, i) => (
              <li key={name} aria-current={i === stage.step ? "step" : undefined}>
                <span className={clsx("block h-1.5 rounded-full", i <= stage.step ? "bg-moving" : "bg-line")} />
                <span className={clsx("mt-1.5 flex items-center gap-1 text-[11.5px]", i <= stage.step ? "font-semibold text-ink" : "text-muted")}>
                  {i < stage.step && <Check size={11} aria-hidden="true" />}
                  {t(name)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <RouteMap
        points={[{ ...view.destination, color: "#cf3a32" }]}
        vehicle={view.vehicle}
        // Re-fits the view when the vehicle appears or disappears, not on every position.
        fitKey={view.vehicle ? "con" : "sin"}
        className="h-[46dvh] min-h-64"
        label={t("pages.delivery.map")}
      />
      <p className="text-center text-[12.5px] text-muted">
        {view.vehicle ? (
          <>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-moving align-middle" />
            {view.vehicle.moving ? t("pages.delivery.vehicleMoving") : t("pages.delivery.vehicleStopped")}
            {view.vehicle.fixTime && <> · {t("pages.delivery.positionAge", { ago: timeAgo(view.vehicle.fixTime, now) })}</>}
            <span className="ml-2 inline-block h-2 w-2 rounded-full bg-danger align-middle" /> {t("pages.delivery.yourAddress")}
          </>
        ) : (
          t("pages.delivery.legend")
        )}
      </p>
    </>
  );
}
