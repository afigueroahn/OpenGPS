// Public page of a shared link: whoever receives it sees where the
// vehicle is, live and without an account. The link key goes after the hash
// of the URL, so the browser never sends it when requesting the page.
import "../lib/mapSetup";
import type { SharedView } from "@opengps/shared";
import { VEHICLE_STATUS_COLOR } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { LocateFixed } from "lucide-react";
import { type GeoJSONSource, Map as MapLibre, NavigationControl } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo, Spinner } from "../components/ui";
import { ApiRequestError, viewShared } from "../lib/api";
import { formatDateTime, timeAgo } from "../lib/format";
import { useConfig, useNow } from "../lib/session";

const REFRESH_MS = 5000;
const STATUS = {
  moving: { label: "shared.vehicleStatus.moving", color: VEHICLE_STATUS_COLOR.moving },
  stopped: { label: "shared.vehicleStatus.stopped", color: VEHICLE_STATUS_COLOR.stopped },
  offline: { label: "shared.vehicleStatus.offline", color: VEHICLE_STATUS_COLOR.offline },
  unknown: { label: "pages.sharedLocation.noPosition", color: VEHICLE_STATUS_COLOR.offline },
} as const satisfies Record<SharedView["status"], { label: string; color: string }>;

/** Heading arrow, drawn once and colored by the map. */
function arrowImage(): ImageData {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.beginPath();
  ctx.moveTo(size / 2, 5);
  ctx.lineTo(size - 11, size - 9);
  ctx.lineTo(size / 2, size - 17);
  ctx.lineTo(11, size - 9);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function SharedMap({ styleUrl, view, follow, onMoved }: { styleUrl: string; view: SharedView; follow: boolean; onMoved: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;
  const first = useRef(true);
  const { t } = useTranslation();

  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibre({ container: container.current, style: styleUrl, center: [-75, -8], zoom: 2.6, attributionControl: { compact: true }, dragRotate: false });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      map.addImage("arrow", arrowImage(), { sdf: true });
      map.addSource("vehicle", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "halo", type: "circle", source: "vehicle", paint: { "circle-radius": 24, "circle-color": ["get", "color"], "circle-opacity": 0.22 } });
      map.addLayer({
        id: "point",
        type: "circle",
        source: "vehicle",
        paint: { "circle-radius": 12, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
      });
      map.addLayer({
        id: "heading",
        type: "symbol",
        source: "vehicle",
        filter: ["has", "course"],
        layout: { "icon-image": "arrow", "icon-size": 0.34, "icon-rotate": ["get", "course"], "icon-rotation-alignment": "map", "icon-allow-overlap": true },
        paint: { "icon-color": "#ffffff" },
      });
      // If the person moves the map, it stops following the vehicle until they ask it to.
      map.on("dragstart", () => onMovedRef.current());
      setReady(true);
    });
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  const p = view.position;
  const moving = view.status === "moving";
  const color = STATUS[view.status].color;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("vehicle") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: p
        ? [{ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { color, ...(moving && p.course !== null ? { course: p.course } : {}) } }]
        : [],
    });
    if (!p || !follow) return;
    if (first.current) map.jumpTo({ center: [p.lon, p.lat], zoom: 15 });
    else map.easeTo({ center: [p.lon, p.lat], duration: 900 });
    first.current = false;
  }, [p, moving, color, follow, ready]);

  return <div ref={container} className="h-full w-full" role="application" aria-label={t("pages.sharedLocation.map")} />;
}

function Gone({ children }: { children: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-[420px] rounded-[18px] bg-surface p-7 text-center shadow-[0_2px_6px_rgb(16_22_35/0.08),0_12px_34px_rgb(16_22_35/0.1)]">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        <h1 className="text-[20px] font-semibold tracking-tight">{t("pages.linkGone.title")}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

export function SharedPage() {
  const [token] = useState(() => location.hash.slice(1));
  const wellFormed = /^[A-Za-z0-9_-]{43}$/.test(token);
  const config = useConfig();
  const now = useNow(5000);
  const [follow, setFollow] = useState(true);
  const { t } = useTranslation();
  const shared = useQuery({
    queryKey: ["shared", token],
    queryFn: () => viewShared(token),
    enabled: wellFormed,
    // While the link is alive it polls every few seconds; if it ceases to exist, it stops.
    refetchInterval: (query) => (query.state.error instanceof ApiRequestError && query.state.error.status === 404 ? false : REFRESH_MS),
    retry: (count, error) => !(error instanceof ApiRequestError && error.status === 404) && count < 2,
  });
  // These pages must not appear in search engines.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.append(meta);
    return () => meta.remove();
  }, []);

  const gone = !wellFormed || (shared.error instanceof ApiRequestError && shared.error.status === 404);
  if (gone) return <Gone>{t("pages.sharedLocation.gone")}</Gone>;
  const view = shared.data;
  if (!view || !config.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas text-muted">
        <Spinner size={22} />
        {shared.isError && <p className="px-6 text-center text-sm">{t("pages.sharedLocation.loadFailed")}</p>}
      </div>
    );
  }

  const status = STATUS[view.status];
  return (
    <div className="relative h-full overflow-hidden">
      <SharedMap styleUrl={config.data.mapStyleUrl} view={view} follow={follow} onMoved={() => setFollow(false)} />
      {!follow && view.position && (
        <button
          type="button"
          onClick={() => setFollow(true)}
          className="absolute right-2.5 top-[84px] flex h-[29px] w-[29px] items-center justify-center rounded-[10px] bg-surface text-ink shadow-[0_1px_2px_rgb(16_22_35/0.12),0_4px_14px_rgb(16_22_35/0.1)]"
          aria-label={t("pages.sharedLocation.follow")}
          title={t("pages.sharedLocation.followTitle")}
        >
          <LocateFixed size={16} />
        </button>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3 pb-9 sm:p-5 sm:pb-9">
        <section className="on-dark pointer-events-auto w-full max-w-[440px] rounded-[18px] bg-ink p-5 text-white shadow-[0_8px_30px_rgb(16_22_35/0.3)]" aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <Logo dark size={24} />
            <span className="text-[11px] font-medium uppercase tracking-wider text-white/45">{t("pages.sharedLocation.title")}</span>
          </div>
          <h1 className="mt-4 truncate text-[22px] font-semibold tracking-tight">{view.name}</h1>
          <div className="mt-2 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: status.color }} />
                {t(status.label)}
              </p>
              <p className="mt-1 text-[13px] text-white/55">
                {view.lastSeenAt ? t("pages.sharedLocation.lastReport", { ago: timeAgo(view.lastSeenAt, now) }) : t("pages.sharedLocation.noReport")}
              </p>
            </div>
            {view.position && view.status === "moving" && (
              <p className="shrink-0 text-right leading-none">
                <span className="num text-[34px] font-semibold tracking-tight">{view.position.speedKmh}</span>
                <span className="ml-1 text-[13px] text-white/50">km/h</span>
              </p>
            )}
          </div>
          <p className="mt-4 border-t border-white/10 pt-3 text-[12.5px] text-white/45">{t("pages.sharedLocation.validUntil", { date: formatDateTime(view.expiresAt) })}</p>
        </section>
      </div>
    </div>
  );
}
