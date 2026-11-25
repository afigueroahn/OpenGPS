// Driver page: with the link to their dispatch they see their stops on the
// phone, mark each one and leave the proof of delivery (who received it, a
// photo and the signature). It does not ask for an account. The link key goes after the hash
// of the URL, so the browser never sends it when requesting the page.
import type { DriverTripView, RouteTripStop } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, Check, Eraser, MapPinned, Navigation, X } from "lucide-react";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { RouteMap, STOP_COLOR } from "../app/routes/RouteMap";
import { Button, Field, Logo, Modal, Notice, Spinner } from "../components/ui";
import { ApiRequestError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import i18n from "../lib/i18n";
import { setDriverStop, setDriverTripStatus, uploadProof, viewDriverTrip } from "../lib/routes";

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : i18n.t("pages.driver.actionFailed"));
/** To open the phone's navigation to the stop. */
const directions = (s: { lat: number; lon: number }) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;

/** A photo from the phone, downsized so it uploads fast on a weak signal. */
async function shrink(file: File): Promise<Blob> {
  try {
    const image = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    return blob ?? file;
  } catch {
    return file;
  }
}

export function DriverPage() {
  const queryClient = useQueryClient();
  const [token] = useState(() => window.location.hash.slice(1));
  const trip = useQuery({ queryKey: ["driver-trip", token], queryFn: () => viewDriverTrip(token), enabled: token.length >= 20, refetchInterval: 30_000, retry: (count, err) => !(err instanceof ApiRequestError && err.status === 404) && count < 2 });
  const [delivering, setDelivering] = useState<{ stop: RouteTripStop; failed: boolean } | null>(null);
  const [ending, setEnding] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { t } = useTranslation();
  const put = (view: DriverTripView) => {
    queryClient.setQueryData(["driver-trip", token], view);
    setFailed(null);
  };
  const fail = (err: unknown) => setFailed(errorText(err));
  const status = useMutation({
    mutationFn: (next: "in_progress" | "done") => setDriverTripStatus(token, next),
    onSuccess: (view) => {
      put(view);
      setEnding(false);
    },
    onError: fail,
  });
  const arrive = useMutation({ mutationFn: (stopId: string) => setDriverStop(token, stopId, { status: "arrived", recipient: null, note: null }), onSuccess: put, onError: fail });

  if (token.length < 20 || (trip.isError && !trip.data)) {
    return (
      <Shell>
        <div className="rounded-[18px] bg-surface p-7 text-center shadow-[0_2px_6px_rgb(16_22_35/0.08)]">
          <h1 className="text-[19px] font-semibold tracking-tight">{t("pages.linkGone.title")}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-3">{t("pages.linkGone.askNew")}</p>
        </div>
      </Shell>
    );
  }
  if (!trip.data) {
    return (
      <Shell>
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner size={24} />
        </div>
      </Shell>
    );
  }
  const view = trip.data;
  const open = view.status === "assigned" || view.status === "in_progress";
  const left = view.stops.filter((s) => s.status === "pending" || s.status === "arrived").length;
  const next = view.stops.find((s) => s.status === "pending" || s.status === "arrived");

  return (
    <Shell account={view.account}>
      <section className="on-dark rounded-[16px] bg-panel px-5 py-4 text-white">
        <p className="text-[12px] font-medium uppercase tracking-wider text-white/55">{t(`shared.routeTripStatus.${view.status}`)}</p>
        <h1 className="mt-0.5 text-[21px] font-semibold leading-tight tracking-tight">{view.name}</h1>
        <p className="mt-1 text-[14px] text-white/70">
          {view.vehicleName}
          {view.driver && ` · ${view.driver}`} · <Trans i18nKey="pages.driver.departs" values={{ date: formatDateTime(view.startsAt) }} components={{ num: <span className="num" /> }} />
        </p>
        <p className="mt-2 text-[14px] text-white/85">{open ? (left === 0 ? t("pages.driver.allStopsDone") : t("pages.driver.stopsLeft", { count: left, total: view.stops.length })) : view.status === "done" ? t("pages.driver.finished") : t("pages.driver.cancelled")}</p>
        {view.status === "assigned" && (
          <Button variant="signal" full className="mt-3" loading={status.isPending} onClick={() => status.mutate("in_progress")}>
            {t("pages.driver.start")}
          </Button>
        )}
      </section>

      {failed && <Notice tone="error">{failed}</Notice>}
      <RouteMap line={view.line} points={view.stops.map((s) => ({ lat: s.lat, lon: s.lon, label: String(s.seq), color: STOP_COLOR[s.status] }))} fitKey={view.stops.length} className="h-48" />

      <ol className="space-y-2.5">
        {view.stops.map((s) => {
          const pending = s.status === "pending" || s.status === "arrived";
          return (
            <li key={s.id} className={clsx("rounded-[14px] border bg-surface px-4 py-3.5", next?.id === s.id && open ? "border-ink" : "border-line")}>
              <div className="flex items-start gap-3">
                <span className="num mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12.5px] font-semibold text-white" style={{ background: STOP_COLOR[s.status] }}>
                  {s.seq}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold leading-snug text-ink">{s.name}</p>
                  <p className="text-[13px] text-muted">
                    {t(`shared.routeStopStatus.${s.status}`)}
                    {s.plannedAt && (
                      <>
                        {" "}
                        · <Trans i18nKey="pages.driver.planned" values={{ date: formatDateTime(s.plannedAt) }} components={{ num: <span className="num" /> }} />
                      </>
                    )}
                    {s.contact && <> · {t("pages.driver.receives", { name: s.contact })}</>}
                  </p>
                  {(s.recipient || s.note) && (
                    <p className="mt-0.5 text-[13px] text-ink-3">
                      {s.recipient && t("pages.driver.received", { name: s.recipient })}
                      {s.recipient && s.note && " · "}
                      {s.note && t("pages.driver.quote", { note: s.note })}
                    </p>
                  )}
                </div>
              </div>
              {open && pending && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <a href={directions(s)} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] border border-line bg-surface text-sm font-semibold text-ink">
                    <Navigation size={16} aria-hidden="true" /> {t("pages.driver.directions")}
                  </a>
                  {s.status === "pending" ? (
                    <Button variant="secondary" className="h-11" loading={arrive.isPending && arrive.variables === s.id} onClick={() => arrive.mutate(s.id)}>
                      <MapPinned size={16} aria-hidden="true" /> {t("pages.driver.arrive")}
                    </Button>
                  ) : (
                    <span className="flex h-11 items-center justify-center rounded-[10px] bg-idle/15 text-sm font-semibold text-[#8a5a00]">{t("pages.driver.onSite")}</span>
                  )}
                  <Button className="h-11" onClick={() => setDelivering({ stop: s, failed: false })}>
                    <Check size={16} aria-hidden="true" /> {t("pages.driver.deliver")}
                  </Button>
                  <Button variant="danger" className="h-11" onClick={() => setDelivering({ stop: s, failed: true })}>
                    <X size={16} aria-hidden="true" /> {t("pages.driver.couldNot")}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {view.status === "in_progress" &&
        (ending ? (
          <div className="space-y-2 rounded-[14px] border border-line bg-surface px-4 py-3.5">
            <p className="text-[14.5px] leading-relaxed text-ink-3">{left > 0 ? t("pages.driver.unattended", { count: left }) : t("pages.driver.closing")}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setEnding(false)}>
                {t("pages.driver.keepGoing")}
              </Button>
              <Button loading={status.isPending} onClick={() => status.mutate("done")}>
                {t("pages.driver.end")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" full onClick={() => setEnding(true)}>
            {t("pages.driver.endRoute")}
          </Button>
        ))}

      {delivering && <DeliverSheet token={token} stop={delivering.stop} failed={delivering.failed} onClose={() => setDelivering(null)} onDone={put} />}
    </Shell>
  );
}

function Shell({ account, children }: { account?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-canvas">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <Logo />
        {account && <span className="truncate text-sm text-muted">{account}</span>}
      </header>
      <main className="mx-auto max-w-[560px] space-y-3.5 px-4 py-4">{children}</main>
    </div>
  );
}

/** What is recorded on delivering, or on being unable to: who received it, a note, the photo and the signature. */
function DeliverSheet({ token, stop, failed, onClose, onDone }: { token: string; stop: RouteTripStop; failed: boolean; onClose: () => void; onDone: (view: DriverTripView) => void }) {
  const [recipient, setRecipient] = useState(stop.contact ?? "");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const pad = useRef<SignatureHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { t } = useTranslation();
  useEffect(() => {
    if (!photo) return setPreview(null);
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  const send = useMutation({
    mutationFn: async () => {
      // Images first: if one fails to upload, the stop stays open to retry.
      if (photo) await uploadProof(token, stop.id, "photo", await shrink(photo));
      const signature = failed ? null : await pad.current?.image();
      if (signature) await uploadProof(token, stop.id, "signature", signature);
      return setDriverStop(token, stop.id, { status: failed ? "failed" : "done", recipient: failed ? null : recipient || null, note: note || null });
    },
    onSuccess: (view) => {
      onDone(view);
      onClose();
    },
    onError: (err) => setProblem(errorText(err)),
  });
  const submit = () => {
    if (failed && !note.trim()) return setProblem(t("pages.driver.sheet.whyMissing"));
    setProblem(null);
    send.mutate();
  };
  return (
    <Modal open onClose={onClose} title={failed ? t("pages.driver.sheet.failedTitle", { stop: stop.name }) : t("pages.driver.sheet.deliverTitle", { stop: stop.name })}>
      <div className="space-y-3.5">
        {!failed && <Field label={t("pages.driver.sheet.recipient")} value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={80} />}
        <Field label={failed ? t("pages.driver.sheet.why") : t("pages.driver.sheet.note")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={failed ? t("pages.driver.sheet.whyPlaceholder") : ""} />
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{failed ? t("pages.driver.sheet.photoOfPlace") : t("pages.driver.sheet.photo")}</span>
          <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" aria-label={t("pages.driver.sheet.photoInput")} onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          {preview ? (
            <div className="flex items-center gap-3">
              <img src={preview} alt={t("pages.driver.sheet.photoTaken")} className="h-20 w-28 rounded-[10px] border border-line object-cover" />
              <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
                {t("pages.driver.sheet.retake")}
              </Button>
            </div>
          ) : (
            <Button variant="secondary" full onClick={() => input.current?.click()}>
              <Camera size={16} aria-hidden="true" /> {t("pages.driver.sheet.takePhoto")}
            </Button>
          )}
        </div>
        {!failed && (
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{t("pages.driver.sheet.signature")}</span>
            <SignaturePad ref={pad} />
          </div>
        )}
        {problem && <Notice tone="error">{problem}</Notice>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant={failed ? "danger" : "primary"} loading={send.isPending} onClick={submit}>
            {failed ? t("pages.driver.sheet.recordFailed") : t("pages.driver.sheet.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface SignatureHandle {
  /** The signature as an image, or null if nothing was drawn. */
  image(): Promise<Blob | null>;
}

/** A box to sign with a finger. */
function SignaturePad({ ref }: { ref: React.Ref<SignatureHandle> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [used, setUsed] = useState(false);
  const usedRef = useRef(false);
  usedRef.current = used;
  const { t } = useTranslation();
  /**
   * Makes the box ready to draw on, at its current size. This is done on the
   * first stroke and not on mount: inside a window that has not yet
   * opened, the box measures zero.
   */
  const prepare = () => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || c.clientWidth === 0) return null;
    // As many points as the screen has real pixels, so the stroke comes out sharp.
    const ratio = window.devicePixelRatio || 1;
    if (c.width !== Math.round(c.clientWidth * ratio) || c.height !== Math.round(c.clientHeight * ratio)) {
      c.width = Math.round(c.clientWidth * ratio);
      c.height = Math.round(c.clientHeight * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    }
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#101623";
    return ctx;
  };
  useEffect(() => {
    const handle: SignatureHandle = { image: () => new Promise((resolve) => (usedRef.current && canvas.current ? canvas.current.toBlob(resolve, "image/png") : resolve(null))) };
    if (typeof ref === "function") ref(handle);
    else if (ref) ref.current = handle;
  }, [ref]);
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top] as const;
  };
  const start = (e: PointerEvent<HTMLCanvasElement>) => {
    const ctx = prepare();
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const [x, y] = at(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    const [x, y] = at(e);
    ctx?.lineTo(x, y);
    ctx?.stroke();
    if (!used) setUsed(true);
  };
  const clear = () => {
    const c = canvas.current;
    const ctx = prepare();
    if (!c || !ctx) return;
    ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    setUsed(false);
  };
  return (
    <div className="relative">
      <canvas ref={canvas} onPointerDown={start} onPointerMove={move} onPointerUp={() => (drawing.current = false)} onPointerCancel={() => (drawing.current = false)} className="h-36 w-full touch-none rounded-[10px] border border-line bg-white" aria-label={t("pages.driver.signature.label")} />
      {used ? (
        <button type="button" onClick={clear} className="absolute right-2 top-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-canvas px-2.5 text-[12.5px] font-medium text-ink-3">
          <Eraser size={13} aria-hidden="true" /> {t("pages.driver.signature.clear")}
        </button>
      ) : (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-faint">{t("pages.driver.signature.hint")}</span>
      )}
    </div>
  );
}
