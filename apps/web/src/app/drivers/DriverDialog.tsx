// Driver profile, the account's driving settings and, inside the
// vehicle detail, who drives it.
import { DRIVER_EVENT_POINTS, DRIVER_EVENT_TYPES, type Driver, type DriverSettings, SCORE_MIN_KM, SHIFT_REST_MIN, type Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { IdCard, KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice } from "../../components/ui";
import { deleteDriver, getDriverSettings, getDrivers, getVehicleDriver, saveDriver, saveDriverSettings, setVehicleDriver } from "../../lib/api";
import { formatDuration, timeAgo } from "../../lib/format";
import { errorText } from "../widgets";

/** Create or edit a driver. `keyId` brings an already typed key that the device read. */
export function DriverDialog({ driver, keyId, onClose }: { driver: Driver | null; keyId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(driver?.name ?? "");
  const [license, setLicense] = useState(driver?.license ?? "");
  const [phone, setPhone] = useState(driver?.phone ?? "");
  const [key, setKey] = useState(driver?.keyId ?? keyId ?? "");
  const [notes, setNotes] = useState(driver?.notes ?? "");
  const [active, setActive] = useState(driver?.active ?? true);
  const [confirming, setConfirming] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["drivers"] });
    void queryClient.invalidateQueries({ queryKey: ["vehicle-driver"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => saveDriver({ name: name.trim(), license: license.trim() || null, phone: phone.trim() || null, keyId: key.trim() || null, notes: notes.trim(), active }, driver?.id),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => deleteDriver(driver?.id ?? ""), onSuccess: refresh });
  const keyProblem = key.trim() && !/^[0-9A-Fa-f]{4,32}$/.test(key.trim()) ? t("drivers.dialog.keyProblem") : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !keyProblem) save.mutate();
  };

  return (
    <Modal open onClose={onClose} title={driver ? t("drivers.dialog.editTitle") : t("drivers.dialog.newTitle")}>
      {confirming && driver ? (
        <div className="space-y-5">
          <p className="text-[15px] leading-relaxed text-ink-3">
            <Trans i18nKey="drivers.dialog.deleteBody" values={{ name: driver.name }} components={{ b: <strong className="font-semibold text-ink" /> }} />
          </p>
          {remove.isError && <Notice tone="error">{errorText(remove.error)}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t("drivers.dialog.deleteConfirm")}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus={!keyId} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("drivers.dialog.license")} value={license} onChange={(e) => setLicense(e.target.value)} maxLength={40} mono />
            <Field label={t("drivers.dialog.phone")} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} inputMode="tel" mono />
          </div>
          <Field
            label={t("drivers.dialog.key")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            maxLength={32}
            mono
            autoCapitalize="characters"
            spellCheck={false}
            error={keyProblem}
            hint={t("drivers.dialog.keyHint")}
          />
          <Field label={t("drivers.dialog.notes")} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          {driver && (
            <label className="flex items-center gap-2.5 text-[15px] text-ink">
              <input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} className="h-4 w-4 accent-ink" />
              {t("drivers.dialog.inactive")}
            </label>
          )}
          {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
          <div className="flex items-center justify-between gap-2 pt-1">
            {driver ? (
              <button type="button" onClick={() => setConfirming(true)} className="text-[13px] font-semibold text-danger hover:underline">
                {t("drivers.dialog.delete")}
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={!name.trim() || Boolean(keyProblem)}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Labels, units and hints are catalog keys, said where the fields are drawn.
const SETTING_FIELDS: {
  key: keyof DriverSettings;
  label: "speedLimit" | "speedingSeconds" | "maxContinuous" | "minRest" | "maxDaily";
  unit: "kmh" | "seconds" | "minutes";
  min: number;
  max: number;
  hint?: "speedingHint";
}[] = [
  { key: "speedLimitKmh", label: "speedLimit", unit: "kmh", min: 20, max: 200 },
  { key: "speedingSeconds", label: "speedingSeconds", unit: "seconds", min: 0, max: 300, hint: "speedingHint" },
  { key: "maxContinuousMin", label: "maxContinuous", unit: "minutes", min: 30, max: 720 },
  { key: "minRestMin", label: "minRest", unit: "minutes", min: 5, max: 240 },
  { key: "maxDailyMin", label: "maxDaily", unit: "minutes", min: 60, max: 1440 },
];

/** Limits used to measure the account's drivers. */
export function DriverSettingsDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["drivers", "settings"], queryFn: getDriverSettings });
  const [draft, setDraft] = useState<Record<keyof DriverSettings, string> | null>(null);
  useEffect(() => {
    if (settings.data && !draft) setDraft(Object.fromEntries(Object.entries(settings.data).map(([k, v]) => [k, String(v)])) as Record<keyof DriverSettings, string>);
  }, [settings.data, draft]);
  const parsed = draft ? (Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])) as unknown as DriverSettings) : null;
  const problem = (() => {
    if (!parsed) return null;
    for (const f of SETTING_FIELDS) {
      const n = parsed[f.key];
      if (!Number.isInteger(n) || n < f.min || n > f.max) return t("drivers.settings.range", { label: t(`drivers.settings.${f.label}`), min: f.min, max: f.max, unit: t(`drivers.settings.unit.${f.unit}`) });
    }
    return null;
  })();
  const save = useMutation({
    mutationFn: () => saveDriverSettings(parsed as DriverSettings),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drivers"] });
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose} title={t("drivers.settings.title")}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed && !problem) save.mutate();
        }}
      >
        {draft &&
          SETTING_FIELDS.map((f) => {
            const asHours = f.unit === "minutes" && Number(draft[f.key]) >= 60 ? t("drivers.settings.asHours", { duration: formatDuration(Number(draft[f.key]) * 60) }) : undefined;
            return (
              <Field
                key={f.key}
                label={`${t(`drivers.settings.${f.label}`)} (${t(`drivers.settings.unit.${f.unit}`)})`}
                value={draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value.replace(/[^\d]/g, "") })}
                inputMode="numeric"
                mono
                disabled={!canManage}
                hint={f.hint ? t(`drivers.settings.${f.hint}`) : asHours}
              />
            );
          })}
        <div className="rounded-[12px] bg-canvas px-4 py-3 text-[13.5px] leading-relaxed text-ink-3">
          <p className="font-semibold text-ink">{t("drivers.scoreTitle")}</p>
          <p className="mt-1">
            {t("drivers.settings.scoreLead", {
              events: DRIVER_EVENT_TYPES.map((type) => `${t(`shared.driverEvent.${type}`).toLowerCase()} ${DRIVER_EVENT_POINTS[type]}`).join(", "),
              km: SCORE_MIN_KM,
              hours: SHIFT_REST_MIN / 60,
            })}
          </p>
        </div>
        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {canManage ? t("common.cancel") : t("common.close")}
          </Button>
          {canManage && (
            <Button type="submit" loading={save.isPending} disabled={!parsed || Boolean(problem)}>
              {t("common.save")}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** In a vehicle's detail: who drives it, and change it. */
export function VehicleDriverCard({ vehicle, canManage, now }: { vehicle: Vehicle; canManage: boolean; now: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ["vehicle-driver", vehicle.id];
  const current = useQuery({ queryKey: key, queryFn: () => getVehicleDriver(vehicle.id) });
  const drivers = useQuery({ queryKey: ["drivers", "list"], queryFn: getDrivers, enabled: canManage });
  const [registering, setRegistering] = useState<string | null>(null);
  const assign = useMutation({
    mutationFn: (driverId: string | null) => setVehicleDriver(vehicle.id, driverId),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      void queryClient.invalidateQueries({ queryKey: ["drivers"] });
    },
  });
  if (!current.data) return null;
  const { driver, unknownKey } = current.data;
  const active = (drivers.data ?? []).filter((d) => d.active || d.id === driver?.id);

  return (
    <div className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <IdCard size={18} className={clsx("mt-0.5 shrink-0", driver ? "text-signal" : "text-white/45")} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{driver ? driver.name : t("drivers.card.none")}</p>
          <p className="text-[13px] leading-snug text-white/55">
            {driver
              ? t(driver.source === "key" ? "drivers.card.sinceKey" : "drivers.card.since", { when: timeAgo(driver.since, now) })
              : t("drivers.card.noneNote")}
          </p>
        </div>
      </div>
      {canManage && active.length > 0 && (
        <select
          aria-label={t("drivers.card.select")}
          value={driver?.id ?? ""}
          disabled={assign.isPending}
          onChange={(e) => assign.mutate(e.target.value || null)}
          className="mt-3 h-10 w-full rounded-[10px] border-0 bg-ink px-3 text-[14px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50"
        >
          <option value="">{t("drivers.card.noDriver")}</option>
          {active.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      {canManage && drivers.isSuccess && active.length === 0 && <p className="mt-2 text-[13px] leading-snug text-white/55">{t("drivers.card.noDrivers")}</p>}
      {assign.isError && <p className="mt-2 text-[13px] text-coral">{errorText(assign.error)}</p>}
      {unknownKey && (
        <div className="mt-3 rounded-[10px] bg-ink px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-apricot">
            <KeyRound size={14} /> {t("drivers.card.unknownKey")}
          </p>
          <p className="mt-0.5 text-[13px] leading-snug text-white/60">
            <Trans
              i18nKey="drivers.card.unknownKeyBody"
              values={{ key: unknownKey.key, when: timeAgo(unknownKey.at, now) }}
              components={{ id: <span className="num break-all text-white" /> }}
            />
          </p>
          {canManage && (
            <button type="button" onClick={() => setRegistering(unknownKey.key)} className="mt-2 text-[13px] font-semibold text-white underline underline-offset-2">
              {t("drivers.card.register")}
            </button>
          )}
        </div>
      )}
      {registering && <DriverDialog driver={null} keyId={registering} onClose={() => setRegistering(null)} />}
    </div>
  );
}
