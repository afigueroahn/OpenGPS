// "Add my GPS" wizard: vehicle details, brand and identifier,
// instructions to configure the device, and waiting for the first signal.
import { type DeviceModel, type PublicConfig, type Vehicle, uniqueIdSchema } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Check, SatelliteDish } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ComboOption, Combobox } from "../components/Combobox";
import { Button, CopyText, Field, Modal, Notice, Spinner } from "../components/ui";
import { ApiRequestError, attachDevice, createVehicle, getModels } from "../lib/api";
import { minutesUntil } from "../lib/format";
import { useNow } from "../lib/session";

type Step = "vehicle" | "device" | "setup";

interface Props {
  open: boolean;
  onClose: () => void;
  config: PublicConfig;
  vehicles: Vehicle[];
  /** Existing vehicle: to connect a GPS to it or resume one waiting for a signal. */
  vehicle?: Vehicle | null;
  onShow: (vehicleId: string) => void;
}

const fill = (text: string, model: DeviceModel, config: PublicConfig) =>
  text
    .replaceAll("{host}", config.gatewayHost)
    .replaceAll("{ip}", config.gatewayIp ?? config.gatewayHost)
    .replaceAll("{port}", String(model.port));

/** A family and one of its models as a single choice of the search box; without a model, the family alone. */
const choiceOf = (modelId: string, modelName: string | null) => (modelId ? `${modelId}|${modelName ?? ""}` : "");

export function AddGpsWizard({ open, onClose, config, vehicles, vehicle, onShow }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["device-models"], queryFn: getModels, staleTime: Number.POSITIVE_INFINITY, enabled: open });
  const resuming = Boolean(vehicle?.device);

  const [step, setStep] = useState<Step>("vehicle");
  const [name, setName] = useState("");
  const [plate, setPlate] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState<string | null>(null);
  const [uniqueId, setUniqueId] = useState("");
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Each time it opens, it starts where it should.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(vehicle?.name ?? "");
    setPlate(vehicle?.plate ?? "");
    setUniqueId(vehicle?.device?.uniqueId ?? "");
    setModelId(vehicle?.device?.modelId ?? "");
    setModelName(vehicle?.device?.modelName ?? null);
    setVehicleId(vehicle?.id ?? null);
    setStep(vehicle?.device ? "setup" : vehicle ? "device" : "vehicle");
  }, [open, vehicle]);

  const model = models.data?.find((m) => m.id === modelId);
  // Every known model, under its family, plus the family itself for a model that is not listed.
  const choices = useMemo<ComboOption[]>(
    () =>
      (models.data ?? []).flatMap((family) => [
        ...family.models.map((name) => ({ id: choiceOf(family.id, name), label: name, group: family.name, keywords: `${family.brand} ${family.protocol}` })),
        { id: choiceOf(family.id, null), label: t("gps.find.other", { family: family.brand }), group: family.name, keywords: `${family.examples} ${family.protocol}` },
      ]),
    [models.data, t],
  );
  const known = (models.data ?? []).reduce((n, family) => n + family.models.length, 0);
  const choose = (id: string) => {
    const cut = id.indexOf("|");
    setModelId(id.slice(0, cut));
    setModelName(id.slice(cut + 1) || null);
  };
  const current = vehicles.find((v) => v.id === vehicleId);
  const connected = step === "setup" && current?.device?.status === "active";
  const expired = step === "setup" && current !== undefined && current.device === null;

  const save = useMutation({
    mutationFn: () =>
      vehicle
        ? attachDevice(vehicle.id, { uniqueId: uniqueId.trim(), modelId, modelName })
        : createVehicle({ name: name.trim(), plate: plate.trim() || null, uniqueId: uniqueId.trim(), modelId, modelName }),
    onSuccess: (saved) => {
      queryClient.setQueryData<Vehicle[]>(["vehicles"], (list) =>
        list ? (list.some((v) => v.id === saved.id) ? list.map((v) => (v.id === saved.id ? saved : v)) : [...list, saved]) : [saved],
      );
      setVehicleId(saved.id);
      setStep("setup");
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : t("map.wizard.addFailed")),
  });

  const submitVehicle = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError(t("map.wizard.needName"));
    setError(null);
    setStep("device");
  };

  const submitDevice = (e: FormEvent) => {
    e.preventDefault();
    if (!model) return setError(t("gps.find.needed"));
    const parsed = uniqueIdSchema.safeParse(uniqueId);
    if (!parsed.success) return setError(t("map.wizard.badId", { idLabel: model.idLabel }));
    setError(null);
    save.mutate();
  };

  const title = t(connected ? "map.wizard.title.connected" : step === "setup" ? "map.wizard.title.setup" : vehicle ? "map.wizard.title.connect" : "map.wizard.title.add");

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      {step !== "setup" && !vehicle && <Progress step={step} />}

      {step === "vehicle" && (
        <form onSubmit={submitVehicle} className="space-y-4" noValidate>
          <Field
            label={t("map.wizard.name")}
            placeholder={t("map.wizard.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
          />
          <Field label={t("map.vehicle.plateOptional")} value={plate} onChange={(e) => setPlate(e.target.value)} maxLength={20} mono />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end pt-1">
            <Button type="submit">{t("common.continue")}</Button>
          </div>
        </form>
      )}

      {step === "device" && (
        <form onSubmit={submitDevice} className="space-y-5" noValidate>
          {models.isLoading ? (
            <div className="flex h-24 items-center justify-center text-muted">
              <Spinner />
            </div>
          ) : (
            <div className="space-y-3">
              <Combobox
                label={t("gps.find.label")}
                options={choices}
                value={choiceOf(modelId, modelName)}
                onChange={choose}
                placeholder={t("gps.find.placeholder")}
                hint={t("gps.find.hint", { models: known, families: models.data?.length ?? 0 })}
                emptyText={t("gps.find.empty")}
              />
              {model && <p className="text-[13px] text-ink-3">{t("gps.find.chosen", { family: model.name, port: model.port })}</p>}
            </div>
          )}

          <Field
            label={model ? t("map.wizard.deviceId", { idLabel: model.idLabel }) : t("map.wizard.deviceIdGeneric")}
            hint={model?.idLabel === "IMEI" ? t("map.wizard.imeiHint") : t("map.wizard.idHint")}
            value={uniqueId}
            onChange={(e) => setUniqueId(e.target.value.replace(/\s+/g, ""))}
            inputMode="numeric"
            autoComplete="off"
            maxLength={20}
            mono
          />

          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex items-center justify-between pt-1">
            {vehicle ? (
              <span />
            ) : (
              <Button type="button" variant="ghost" onClick={() => setStep("vehicle")}>
                <ArrowLeft size={16} /> {t("common.back")}
              </Button>
            )}
            <Button type="submit" loading={save.isPending}>
              {t("map.wizard.submit")}
            </Button>
          </div>
        </form>
      )}

      {step === "setup" && connected && current && (
        <div className="space-y-5 py-2 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-signal text-ink">
            <Check size={28} strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-[17px] font-semibold">{t("map.wizard.reporting", { name: current.name })}</p>
            <p className="mt-1 text-sm text-muted">{t("map.wizard.firstSignal")}</p>
          </div>
          <Button
            size="lg"
            onClick={() => {
              onShow(current.id);
              onClose();
            }}
          >
            {t("map.wizard.showOnMap")}
          </Button>
        </div>
      )}

      {step === "setup" && expired && (
        <div className="space-y-4">
          <Notice tone="error">{t("map.wizard.expired")}</Notice>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t("common.ok")}</Button>
          </div>
        </div>
      )}

      {step === "setup" && !connected && !expired && (
        <div className="space-y-5">
          <Waiting expiresAt={current?.device?.claimExpiresAt ?? null} resumed={resuming} />
          {model ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <CopyText label={t("map.wizard.server")} value={config.gatewayHost} />
                <CopyText label={t("map.wizard.port")} value={String(model.port)} />
              </div>
              <ol className="space-y-4">
                {model.setup.map((s, i) => (
                  <li key={s.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
                    <span className="num flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-[13px] font-semibold text-ink-3">{i + 1}</span>
                    <div className="space-y-2">
                      <p className="pt-0.5 text-sm font-semibold">{s.title}</p>
                      <p className="text-sm text-ink-3">{fill(s.text, model, config)}</p>
                      {s.command && <CopyText value={fill(s.command, model, config)} />}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="text-[13px] text-muted">{t("map.wizard.commandsNote", { brand: model.brand })}</p>
            </>
          ) : (
            <div className="flex h-24 items-center justify-center text-muted">
              <Spinner />
            </div>
          )}
          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="secondary" onClick={onClose}>
              {t("map.wizard.later")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Progress({ step }: { step: Step }) {
  const { t } = useTranslation();
  const steps: { id: Step; label: string }[] = [
    { id: "vehicle", label: t("map.wizard.steps.vehicle") },
    { id: "device", label: t("map.wizard.steps.device") },
    { id: "setup", label: t("map.wizard.steps.setup") },
  ];
  const index = steps.findIndex((s) => s.id === step);
  return (
    <ol className="mb-6 flex items-center gap-2 text-[13px] font-medium">
      {steps.map((s, i) => (
        <li key={s.id} className={clsx("flex items-center gap-2", i > index ? "text-faint" : "text-ink")}>
          <span
            className={clsx(
              "num flex h-6 w-6 items-center justify-center rounded-full text-[12px]",
              i < index && "bg-signal text-ink",
              i === index && "bg-primary text-on-primary",
              i > index && "bg-canvas",
            )}
          >
            {i < index ? <Check size={13} strokeWidth={3} /> : i + 1}
          </span>
          {s.label}
          {i < steps.length - 1 && <span className="mx-1 h-px w-5 bg-line sm:w-8" />}
        </li>
      ))}
    </ol>
  );
}

function Waiting({ expiresAt, resumed }: { expiresAt: string | null; resumed: boolean }) {
  const { t } = useTranslation();
  const now = useNow(20_000);
  const minutes = minutesUntil(expiresAt, now);
  return (
    <div className="on-dark flex items-center gap-4 rounded-[14px] bg-ink px-4 py-4 text-white">
      <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
        <span className="pulse-ring absolute inset-1 rounded-full bg-signal/50" />
        <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-ink-3 text-signal">
          <SatelliteDish size={20} />
        </span>
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold">{t("map.wizard.waiting.title")}</p>
        <p className="text-[13px] text-white/60">
          {resumed ? t("map.wizard.waiting.resumed") : t("map.wizard.waiting.registered")}{" "}
          {expiresAt ? t("map.wizard.waiting.updatesMinutes", { n: minutes }) : t("map.wizard.waiting.updates")}
        </p>
      </div>
    </div>
  );
}
