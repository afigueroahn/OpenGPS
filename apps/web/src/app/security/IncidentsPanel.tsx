// Incident console: what needs someone to handle it. The list, and for
// each incident its timeline, notes, evidence and closing.
import { INCIDENT_RESOLUTIONS, type Incident, type IncidentDetail, type IncidentEntry, type IncidentKind, type IncidentResolution, type Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, BatteryWarning, type LucideIcon, MapPin, Paperclip, ParkingCircle, Plus, RadioTower, Siren, Truck, UserRound, Wrench } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, Notice, Spinner } from "../../components/ui";
import { attendIncident, closeIncident, evidenceUrl, getIncident, getIncidents, noteIncident, reportIncident, uploadEvidence } from "../../lib/api";
import { formatDateTime, timeAgo } from "../../lib/format";
import { Segment, input, label } from "../geofences/GeofencePanel";
import { errorText } from "../widgets";

const ICON: Record<IncidentKind, LucideIcon> = {
  sos: Siren,
  tow: Truck,
  tampering: Wrench,
  jamming: RadioTower,
  power_cut: BatteryWarning,
  movement: ParkingCircle,
  manual: UserRound,
};
const STATUS_COLOR: Record<Incident["status"], string> = { open: "text-coral", attended: "text-apricot", closed: "text-white/50" };

interface Props {
  vehicles: Vehicle[];
  /** Can handle, annotate and close. */
  canManage: boolean;
  now: number;
  /** Takes the map to the incident's vehicle. */
  onShow: (incident: Incident) => void;
  onBack: () => void;
}

export function IncidentsPanel(props: Props) {
  const { t } = useTranslation();
  const [openOnly, setOpenOnly] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const incidents = useQuery({ queryKey: ["incidents", "list", openOnly], queryFn: () => getIncidents(openOnly), refetchInterval: 60_000 });

  if (selected) return <Detail {...props} id={selected} onBack={() => setSelected(null)} />;

  const list = incidents.data ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button type="button" onClick={props.onBack} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white">
          <ArrowLeft size={15} /> {t("common.myVehicles")}
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-2">
        <h1 className="text-[22px] font-semibold tracking-tight">{t("security.incidents.title")}</h1>
        {props.canManage && props.vehicles.length > 0 && (
          <Button variant="signal" size="sm" onClick={() => setReporting(true)}>
            <Plus size={15} strokeWidth={2.5} /> {t("security.incidents.report")}
          </Button>
        )}
      </div>
      <div className="mx-5 mb-3 flex gap-1 rounded-[10px] bg-ink-2 p-1">
        <Segment active={openOnly} onClick={() => setOpenOnly(true)}>
          {t("security.incidents.open")}
        </Segment>
        <Segment active={!openOnly} onClick={() => setOpenOnly(false)}>
          {t("common.all")}
        </Segment>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {incidents.isLoading && (
          <div className="flex h-28 items-center justify-center text-white/50">
            <Spinner />
          </div>
        )}
        {incidents.isError && <p className="px-2 py-4 text-sm text-white/60">{errorText(incidents.error)}</p>}
        {incidents.isSuccess && list.length === 0 && (
          <p className="mx-2 rounded-[14px] bg-ink-2 p-4 text-sm leading-relaxed text-white/60">
            {openOnly ? t("security.incidents.emptyOpen") : t("security.incidents.emptyAll")}
          </p>
        )}
        <ul className="space-y-1.5">
          {list.map((incident) => {
            const Icon = ICON[incident.kind];
            return (
              <li key={incident.id}>
                <button type="button" onClick={() => setSelected(incident.id)} className="flex w-full items-center gap-3 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-ink-2">
                  <span
                    className={clsx(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
                      incident.status !== "closed" && incident.priority === 1 ? "bg-danger text-white" : "bg-ink-2 text-signal",
                    )}
                  >
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">{incident.vehicleName}</span>
                    <span className="block truncate text-[13px] text-white/55">
                      {t(`shared.incidentKind.${incident.kind}`)} · {timeAgo(incident.openedAt, props.now)}
                    </span>
                  </span>
                  <span className={clsx("shrink-0 text-[12.5px] font-semibold", STATUS_COLOR[incident.status])}>{t(`shared.incidentStatus.${incident.status}`)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {reporting && <ReportDialog vehicles={props.vehicles} onClose={() => setReporting(false)} onCreated={(incident) => setSelected(incident.id)} />}
    </div>
  );
}

// ─── An incident ────────────────────────────────────────────────────────────

function Detail(props: Props & { id: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ["incidents", "detail", props.id];
  const query = useQuery({ queryKey: key, queryFn: () => getIncident(props.id) });
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const done = (incident: IncidentDetail) => {
    queryClient.setQueryData(key, incident);
    void queryClient.invalidateQueries({ queryKey: ["incidents", "list"] });
  };
  const attend = useMutation({ mutationFn: () => attendIncident(props.id), onSuccess: done });
  const addNote = useMutation({
    mutationFn: () => noteIncident(props.id, note.trim()),
    onSuccess: (incident) => {
      setNote("");
      done(incident);
    },
  });
  const upload = useMutation({ mutationFn: (file: File) => uploadEvidence(props.id, file), onSuccess: done });
  const incident = query.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (note.trim()) addNote.mutate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button type="button" onClick={props.onBack} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white">
          <ArrowLeft size={15} /> {t("security.incidents.title")}
        </button>
      </div>
      {query.isLoading && (
        <div className="flex h-28 items-center justify-center text-white/50">
          <Spinner />
        </div>
      )}
      {query.isError && <p className="px-5 py-4 text-sm text-white/60">{errorText(query.error)}</p>}
      {incident && (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2">
          <h1 className="truncate text-[22px] font-semibold tracking-tight">{incident.vehicleName}</h1>
          <p className="text-[14px] text-white/70">{t(`shared.incidentKind.${incident.kind}`)}</p>
          <p className={clsx("mt-2 text-sm font-semibold", STATUS_COLOR[incident.status])}>
            {incident.status !== "closed" && incident.priority === 1
              ? t("security.incidents.statusPriority", { status: t(`shared.incidentStatus.${incident.status}`) })
              : t(`shared.incidentStatus.${incident.status}`)}
          </p>
          <p className="mt-0.5 text-[13px] leading-snug text-white/55">
            {incident.attendedBy
              ? t("security.incidents.openedAttended", { when: timeAgo(incident.openedAt, props.now), name: incident.attendedBy })
              : t("security.incidents.opened", { when: timeAgo(incident.openedAt, props.now) })}
            {incident.status === "closed" && incident.resolution && ` · ${t(`shared.incidentResolution.${incident.resolution}`).toLowerCase()}`}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {props.canManage && incident.status === "open" && (
              <Button variant="signal" size="sm" loading={attend.isPending} onClick={() => attend.mutate()}>
                {t("security.incidents.attend")}
              </Button>
            )}
            <button
              type="button"
              onClick={() => props.onShow(incident)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-ink-2 px-3 text-[13px] font-semibold hover:bg-ink-3"
            >
              <MapPin size={14} className="text-signal" /> {t("security.incidents.showOnMap")}
            </button>
            {props.canManage && incident.status !== "closed" && (
              <button type="button" onClick={() => setClosing(true)} className="inline-flex h-8 items-center rounded-[10px] bg-ink-2 px-3 text-[13px] font-semibold hover:bg-ink-3">
                {t("security.incidents.close")}
              </button>
            )}
          </div>
          {attend.isError && <p className="mt-2 text-[13px] text-coral">{errorText(attend.error)}</p>}

          <h2 className="mt-6 text-[11px] font-medium uppercase tracking-wider text-white/45">{t("security.incidents.timeline")}</h2>
          <ol className="mt-2 space-y-0">
            {incident.entries.map((entry, i) => (
              <Entry key={entry.id} entry={entry} incidentId={incident.id} last={i === incident.entries.length - 1} />
            ))}
          </ol>

          {props.canManage && incident.status !== "closed" && (
            <form onSubmit={submit} className="mt-4">
              <label htmlFor="nota-del-incidente" className={label}>
                {t("security.incidents.addNote")}
              </label>
              <textarea
                id="nota-del-incidente"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder={t("security.incidents.notePlaceholder")}
                className={clsx(input, "h-auto resize-none py-2.5 leading-snug")}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button type="submit" variant="signal" size="sm" loading={addNote.isPending} disabled={!note.trim()}>
                  {t("security.incidents.saveNote")}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) upload.mutate(file);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  disabled={upload.isPending}
                  onClick={() => fileInput.current?.click()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-ink-2 px-3 text-[13px] font-semibold hover:bg-ink-3 disabled:opacity-50"
                >
                  {upload.isPending ? <Spinner size={14} /> : <Paperclip size={14} />} {t("security.incidents.attach")}
                </button>
              </div>
              {(addNote.isError || upload.isError) && <p className="mt-2 text-[13px] text-coral">{errorText(addNote.error ?? upload.error)}</p>}
              <p className="mt-2 text-[12.5px] leading-relaxed text-white/45">{t("security.incidents.attachHint")}</p>
            </form>
          )}
        </div>
      )}
      {closing && incident && <CloseDialog incident={incident} onClose={() => setClosing(false)} onDone={done} />}
    </div>
  );
}

const ENTRY_DOT: Record<IncidentEntry["kind"], string> = {
  alarm: "bg-danger",
  escalation: "bg-danger",
  note: "bg-white/60",
  evidence: "bg-white/60",
  command: "bg-apricot",
  recovery: "bg-apricot",
  status: "bg-signal",
};
const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function Entry({ entry, incidentId, last }: { entry: IncidentEntry; incidentId: string; last: boolean }) {
  const { t } = useTranslation();
  return (
    <li className="relative flex gap-3 pb-4">
      {!last && <span className="absolute bottom-0 left-[5px] top-4 w-px bg-white/15" aria-hidden="true" />}
      <span className={clsx("mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ring-2 ring-ink", ENTRY_DOT[entry.kind])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="break-words text-[14px] leading-snug">{entry.text}</p>
        {entry.file && (
          <a
            href={evidenceUrl(incidentId, entry.file.id)}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-lg bg-ink-2 px-2.5 py-1.5 text-[13px] font-medium hover:bg-ink-3"
          >
            <Paperclip size={13} className="shrink-0 text-signal" />
            <span className="truncate">{entry.file.name}</span>
            <span className="num shrink-0 text-white/45">{size(entry.file.size)}</span>
          </a>
        )}
        <p className="mt-0.5 text-[12.5px] text-white/45">
          {formatDateTime(entry.at)} · {entry.userName ?? t("security.incidents.platform")}
        </p>
      </div>
    </li>
  );
}

function CloseDialog({ incident, onClose, onDone }: { incident: IncidentDetail; onClose: () => void; onDone: (incident: IncidentDetail) => void }) {
  const { t } = useTranslation();
  const [resolution, setResolution] = useState<IncidentResolution>(incident.kind === "sos" || incident.kind === "manual" ? "resolved" : "false_alarm");
  const [note, setNote] = useState("");
  const close = useMutation({
    mutationFn: () => closeIncident(incident.id, { resolution, note: note.trim() }),
    onSuccess: (saved) => {
      onDone(saved);
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={t("security.close.title")}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          close.mutate();
        }}
      >
        <div>
          <label htmlFor="como-termino" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("security.close.how")}
          </label>
          <select
            id="como-termino"
            value={resolution}
            onChange={(e) => setResolution(e.target.value as IncidentResolution)}
            className="h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
          >
            {INCIDENT_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {t(`shared.incidentResolution.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="nota-de-cierre" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("security.close.note")}
          </label>
          <textarea
            id="nota-de-cierre"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={3}
            className="w-full resize-none rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
          />
        </div>
        <p className="text-[13px] leading-relaxed text-muted">{t("security.close.lead")}</p>
        {close.isError && <Notice tone="error">{errorText(close.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={close.isPending}>
            {t("security.incidents.close")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReportDialog({ vehicles, onClose, onCreated }: { vehicles: Vehicle[]; onClose: () => void; onCreated: (incident: IncidentDetail) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? "");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!vehicles.some((v) => v.id === vehicleId)) setVehicleId(vehicles[0]?.id ?? "");
  }, [vehicles, vehicleId]);
  const create = useMutation({
    mutationFn: () => reportIncident(vehicleId, note.trim()),
    onSuccess: (incident) => {
      void queryClient.invalidateQueries({ queryKey: ["incidents", "list"] });
      onClose();
      onCreated(incident);
    },
  });
  return (
    <Modal open onClose={onClose} title={t("security.report.title")}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim() && vehicleId) create.mutate();
        }}
      >
        <p className="text-[15px] leading-relaxed text-ink-3">{t("security.report.lead")}</p>
        <div>
          <label htmlFor="vehiculo-del-incidente" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("common.vehicle")}
          </label>
          <select
            id="vehiculo-del-incidente"
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
            className="h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
          >
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.plate ? ` · ${v.plate}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="que-paso" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("security.report.what")}
          </label>
          <textarea
            id="que-paso"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            rows={4}
            autoFocus
            className="w-full resize-none rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
          />
        </div>
        {create.isError && <Notice tone="error">{errorText(create.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!note.trim() || !vehicleId}>
            {t("security.incidents.report")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
