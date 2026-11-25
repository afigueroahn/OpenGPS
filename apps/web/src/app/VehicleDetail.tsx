// Vehicle detail: status, address, power and signal, and its actions.
import { type ModuleKey, type Vehicle, type VehicleGroup, vehicleStatus } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, MapPin, ParkingCircle, Pencil, Route, Share2, Trash2, Unplug } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, StatusLabel } from "../components/ui";
import { deleteVehicle, getAddress, removeDevice, setParked, updateVehicle } from "../lib/api";
import { formatCoords, formatCourse, formatDateTime, formatSpeed, minutesUntil, timeAgo } from "../lib/format";
import { VehicleDriverCard } from "./drivers/DriverDialog";
import { DiagCard } from "./diag/DiagCard";
import { FuelCard } from "./fuel/FuelCard";
import { SecurityCard } from "./security/SecurityCard";
import { ShareDialog } from "./ShareDialog";
import { ConfirmDialog, SignalBars, errorText, useThrottled } from "./widgets";

export function VehicleDetail(props: {
  vehicle: Vehicle;
  groups: VehicleGroup[];
  geocoding: boolean;
  /** Can edit the vehicle, its GPS and delete it. */
  canManage: boolean;
  /** Can create links to share the location. */
  canShare: boolean;
  /** Optional modules enabled on the account. */
  modules: ModuleKey[];
  /** Can lock the engine start and activate recovery mode. */
  canCommand: boolean;
  /** Can change the vehicle's driver. */
  canDrivers: boolean;
  now: number;
  onBack: () => void;
  onHistory: () => void;
  onConnect: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { vehicle, now, canManage } = props;
  const status = vehicleStatus(vehicle, now);
  const state = vehicle.state;
  const live = state && status !== "pending" && status !== "no_device";
  const group = props.groups.find((g) => g.id === vehicle.groupId);
  const [dialog, setDialog] = useState<"edit" | "delete" | "unplug" | "share" | null>(null);

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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-semibold tracking-tight">{vehicle.name}</h1>
            {(vehicle.plate || group) && (
              <p className="truncate text-[13px] text-white/55">
                {vehicle.plate && <span className="num">{vehicle.plate}</span>}
                {vehicle.plate && group && " · "}
                {group?.name}
              </p>
            )}
          </div>
          {canManage && (
            <button
              type="button"
              onClick={() => setDialog("edit")}
              aria-label={t("map.detail.edit")}
              className="rounded-lg p-2 text-white/50 hover:bg-ink-2 hover:text-white"
            >
              <Pencil size={16} />
            </button>
          )}
        </div>

        <StatusLabel status={status} className="mt-3 text-sm font-medium" />

        {status === "no_device" && (
          <Callout title={t("map.detail.noDevice.title")} action={canManage && <Button variant="signal" size="sm" onClick={props.onConnect}>{t("map.detail.noDevice.connect")}</Button>}>
            {t("map.detail.noDevice.body")}
          </Callout>
        )}

        {status === "pending" && (
          <Callout title={t("map.detail.pending.title")} action={canManage && <Button variant="signal" size="sm" onClick={props.onConnect}>{t("map.detail.pending.instructions")}</Button>}>
            {vehicle.device?.claimExpiresAt
              ? t("map.detail.pending.bodyMinutes", { n: minutesUntil(vehicle.device.claimExpiresAt, now) })
              : t("map.detail.pending.body")}
          </Callout>
        )}

        {live && (
          <>
            <div className="mt-5 flex items-baseline gap-2">
              <span className="num text-[52px] font-semibold leading-none tracking-tight">{formatSpeed(state.speedKmh)}</span>
              <span className="text-[15px] text-white/50">km/h</span>
            </div>

            {props.geocoding && state.lat !== null && state.lon !== null && (
              <Address vehicleId={vehicle.id} lat={state.lat} lon={state.lon} moving={status === "moving"} />
            )}

            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
              <Datum label={t("map.detail.lastReport")} value={timeAgo(state.lastSeenAt, now)} title={formatDateTime(state.lastSeenAt)} />
              <Datum label={t("map.detail.course")} value={status === "moving" ? formatCourse(state.course) : "—"} />
              <Datum
                label={t("map.detail.engine")}
                value={state.ignition === null ? "—" : state.ignition ? t("map.detail.engineOn") : t("map.detail.engineOff")}
                note={state.ignition !== null && state.ignitionInferred ? t("map.detail.engineEstimated") : undefined}
              />
              <Datum label={t("map.detail.fixTaken")} value={state.fixTime ? timeAgo(state.fixTime, now) : t("map.detail.noFix")} title={formatDateTime(state.fixTime)} />
              {state.powerVoltage !== null && <Datum label={t("map.detail.vehicleBattery")} value={`${state.powerVoltage.toFixed(1)} V`} mono />}
              {(state.batteryLevel !== null || state.batteryVoltage !== null) && (
                <Datum
                  label={t("map.detail.deviceBattery")}
                  value={state.batteryLevel !== null ? `${state.batteryLevel} %` : `${(state.batteryVoltage as number).toFixed(2)} V`}
                  mono
                />
              )}
              {state.satellites !== null && <Datum label={t("map.detail.satellites")} value={String(state.satellites)} mono />}
              {state.signalBars !== null && (
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-wider text-white/45">{t("map.detail.cellSignal")}</dt>
                  <dd className="mt-1.5">
                    <SignalBars bars={state.signalBars} />
                  </dd>
                </div>
              )}
              <div className="col-span-2">
                <Datum label={t("map.detail.coordinates")} value={formatCoords(state.lat, state.lon)} mono />
              </div>
            </dl>
          </>
        )}

        {live && (
          <button
            type="button"
            onClick={props.onHistory}
            className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-ink-2 text-sm font-semibold transition-colors hover:bg-ink-3"
          >
            <Route size={16} className="text-signal" /> {t("map.detail.history")}
          </button>
        )}
        {live && props.canShare && (
          <button
            type="button"
            onClick={() => setDialog("share")}
            className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-ink-2 text-sm font-semibold transition-colors hover:bg-ink-3"
          >
            <Share2 size={16} className="text-signal" /> {t("map.detail.share")}
          </button>
        )}

        {live && (canManage || vehicle.parkedSince) && <ParkedSwitch vehicle={vehicle} canManage={canManage} now={now} />}
        {live && props.modules.includes("A") && <SecurityCard key={`a-${vehicle.id}`} vehicle={vehicle} canCommand={props.canCommand} now={now} />}
        {vehicle.device && props.modules.includes("B") && <VehicleDriverCard key={`b-${vehicle.id}`} vehicle={vehicle} canManage={props.canDrivers} now={now} />}
        {live && props.modules.includes("F") && <FuelCard key={`f-${vehicle.id}`} vehicle={vehicle} canManage={canManage} now={now} />}
        {live && props.modules.includes("C") && <DiagCard key={`c-${vehicle.id}`} vehicle={vehicle} canManage={canManage} now={now} />}

        {vehicle.device && (
          <div className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-white/45">{t("map.detail.device")}</p>
            <p className="num mt-1 text-sm">{vehicle.device.uniqueId}</p>
            {vehicle.device.modelName && <p className="mt-0.5 text-[13px] text-white/60">{vehicle.device.modelName}</p>}
          </div>
        )}

        <div className={clsx("mt-6 flex flex-wrap gap-2", !canManage && "hidden")}>
          {vehicle.device && (
            <button
              type="button"
              onClick={() => setDialog("unplug")}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-white/60 hover:bg-ink-2 hover:text-white"
            >
              <Unplug size={15} /> {t("map.detail.removeDevice")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDialog("delete")}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-coral hover:bg-ink-2"
          >
            <Trash2 size={15} /> {t("map.detail.delete")}
          </button>
        </div>
      </div>

      <ShareDialog open={dialog === "share"} vehicle={vehicle} onClose={() => setDialog(null)} />
      <EditDialog open={dialog === "edit"} vehicle={vehicle} groups={props.groups} onClose={() => setDialog(null)} />
      <ConfirmDialog open={dialog === "unplug"} title={t("map.detail.unplug.title")} confirm={t("map.detail.unplug.confirm")} onClose={() => setDialog(null)} action={() => removeDevice(vehicle.id)}>
        <Trans i18nKey="map.detail.unplug.body" values={{ id: vehicle.device?.uniqueId ?? "" }} components={{ b: <strong className="num font-semibold" /> }} />
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "delete"}
        title={t("map.detail.remove.title")}
        confirm={t("map.detail.remove.confirm")}
        onClose={() => setDialog(null)}
        action={() => deleteVehicle(vehicle.id)}
        onDone={props.onDeleted}
      >
        <Trans i18nKey="map.detail.remove.body" values={{ name: vehicle.name }} components={{ b: <strong className="font-semibold" /> }} />
      </ConfirmDialog>
    </div>
  );
}

/** Parked mode: if the vehicle moves away from where it was left, a notification arrives. */
function ParkedSwitch({ vehicle, canManage, now }: { vehicle: Vehicle; canManage: boolean; now: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const parked = vehicle.parkedSince !== null;
  const toggle = useMutation({
    mutationFn: () => setParked(vehicle.id, !parked),
    onSuccess: (saved) => queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) => list?.map((v) => (v.id === saved.id ? saved : v))),
  });
  return (
    <div className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <ParkingCircle size={18} className={clsx("shrink-0", parked ? "text-signal" : "text-white/45")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("map.detail.parked.title")}</p>
          <p className="text-[13px] leading-snug text-white/55">
            {parked ? t("map.detail.parked.on", { since: timeAgo(vehicle.parkedSince, now) }) : t("map.detail.parked.off")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={parked}
          aria-label={t("map.detail.parked.title")}
          disabled={!canManage || toggle.isPending}
          onClick={() => toggle.mutate()}
          className={clsx("relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50", parked ? "bg-signal" : "bg-ink-3")}
        >
          <span className={clsx("absolute top-1 h-5 w-5 rounded-full bg-white transition-all", parked ? "left-6" : "left-1")} />
        </button>
      </div>
      {toggle.isError && <p className="mt-2 text-[13px] text-coral">{errorText(toggle.error)}</p>}
    </div>
  );
}

/**
 * Approximate address. Requested again when the vehicle changes zone
 * (about 110 m), and while moving at most every 20 seconds.
 */
function Address({ vehicleId, lat, lon, moving }: { vehicleId: string; lat: number; lon: number; moving: boolean }) {
  const { t } = useTranslation();
  const cell = useThrottled(`${lat.toFixed(3)},${lon.toFixed(3)}`, moving ? 20_000 : 0);
  const address = useQuery({
    queryKey: ["address", vehicleId, cell],
    queryFn: () => getAddress(vehicleId),
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
    retry: false,
  });
  if (!address.data) return null;
  return (
    <p className="mt-3 flex items-start gap-1.5 text-[14px] leading-snug text-white/80">
      <MapPin size={15} className="mt-0.5 shrink-0 text-signal" aria-hidden="true" />
      <span>
        <span className="sr-only">{t("map.detail.near")} </span>
        {address.data}
      </span>
    </p>
  );
}

function Datum({ label, value, title, mono, note }: { label: string; value: string; title?: string; mono?: boolean; note?: string | undefined }) {
  return (
    <div title={title}>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-white/45">{label}</dt>
      <dd className={clsx("mt-0.5 text-[15px]", mono && "num text-sm")}>{value}</dd>
      {note && <dd className="text-[12px] text-white/45">{note}</dd>}
    </div>
  );
}

function Callout({ title, children, action }: { title: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className="mt-4 rounded-[14px] bg-ink-2 p-4">
      <p className="text-[15px] font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-white/60">{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function EditDialog({ open, vehicle, groups, onClose }: { open: boolean; vehicle: Vehicle; groups: VehicleGroup[]; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(vehicle.name);
  const [plate, setPlate] = useState(vehicle.plate ?? "");
  const [groupId, setGroupId] = useState(vehicle.groupId ?? "");
  useEffect(() => {
    if (open) {
      setName(vehicle.name);
      setPlate(vehicle.plate ?? "");
      setGroupId(vehicle.groupId ?? "");
    }
  }, [open, vehicle.name, vehicle.plate, vehicle.groupId]);

  const save = useMutation({
    mutationFn: () => updateVehicle(vehicle.id, { name: name.trim(), plate: plate.trim() || null, groupId: groupId || null }),
    onSuccess: (saved) => {
      queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) => list?.map((v) => (v.id === saved.id ? saved : v)));
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title={t("map.detail.edit")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        <Field label={t("map.vehicle.plateOptional")} value={plate} onChange={(e) => setPlate(e.target.value)} maxLength={20} mono />
        {groups.length > 0 && (
          <div>
            <label htmlFor="grupo-del-vehiculo" className="mb-1.5 block text-[13px] font-medium text-ink-3">
              {t("common.group")}
            </label>
            <select
              id="grupo-del-vehiculo"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
            >
              <option value="">{t("map.vehicle.noGroup")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!name.trim()}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
