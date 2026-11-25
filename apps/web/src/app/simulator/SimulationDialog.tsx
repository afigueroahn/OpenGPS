// A simulated device, as it is written: its brand and identifier, where it
// connects, how often it reports and the route it travels.
import { type SimEnd, type SimRouteSummary, type SimulationInput, type SimulationSummary, type SimulatorMeta, generateSimId, simIdProblem } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dices } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice } from "../../components/ui";
import { formatKm } from "../../lib/format";
import { sayShared } from "../../lib/i18n";
import { saveSimulation } from "../../lib/simulator";
import { labelClass, selectClass } from "../reports/kit";
import { errorText } from "../widgets";
import { ScenarioOptions } from "./ScenarioOptions";
import { carried, scenarioDraft, scenarioOf } from "./scenarioDraft";

/** A whole number typed by hand, within its range; null if it is not one. */
const whole = (text: string, min: number, max: number): number | null => {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export function SimulationDialog({ simulation, meta, routes, onClose, onSaved }: { simulation: SimulationSummary | null; meta: SimulatorMeta; routes: SimRouteSummary[]; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(simulation?.name ?? "");
  const [modelId, setModelId] = useState(simulation?.modelId ?? meta.brands[0]?.modelId ?? "");
  const [identifier, setIdentifier] = useState(simulation?.identifiers[0] ?? "");
  // As on a real GPS: the server and the port it reports to. A new one starts with the address
  // real devices are given to reach this platform, and the port of its brand.
  const [host, setHost] = useState(simulation?.host ?? meta.host);
  const [port, setPort] = useState(String(simulation?.port ?? meta.brands[0]?.port ?? ""));
  const [interval, setInterval] = useState(String(simulation?.intervalS ?? 5));
  const [routeId, setRouteId] = useState(simulation?.routeId ?? routes[0]?.id ?? "");
  const [speed, setSpeed] = useState(String(simulation?.scenario.cruiseKmh ?? 45));
  const [end, setEnd] = useState<SimEnd>(simulation?.scenario.end ?? "loop");
  const [idle, setIdle] = useState(String(simulation?.scenario.idleS ?? 20));
  const [rest, setRest] = useState(String(simulation?.scenario.restS ?? 240));
  const [options, setOptions] = useState(() => scenarioDraft(simulation?.scenario ?? null));
  const [problem, setProblem] = useState<string | null>(null);

  const brand = meta.brands.find((b) => b.modelId === modelId);
  const route = routes.find((r) => r.id === routeId);
  // Going around only makes sense on a circuit.
  const ends: SimEnd[] = route?.closed ? ["loop", "return", "stay"] : ["return", "stay"];
  const shownEnd = ends.includes(end) ? end : "return";

  /** Another brand may not carry what the route asked of the old one: that is taken out, so it is not rejected on saving. */
  const changeBrand = (next: string) => {
    const chosen = meta.brands.find((b) => b.modelId === next);
    // Each brand has its own port: it follows the brand, unless another one was written by hand.
    if (chosen && port === String(brand?.port ?? "")) setPort(String(chosen.port));
    setModelId(next);
    const capabilities = chosen?.capabilities ?? [];
    setOptions((old) => ({
      ...old,
      actions: old.actions.filter((a) => carried(capabilities, a.kind, a.kind === "alarm" ? a.alarm : undefined)),
      fuelOn: old.fuelOn && capabilities.includes("fuel"),
      driverKey: capabilities.includes("driverKey") ? old.driverKey : "",
      reportIgnition: capabilities.includes("voltage") ? old.reportIgnition : true,
      extraIo: capabilities.includes("extraIo") ? old.extraIo : "",
    }));
  };

  const save = useMutation({
    mutationFn: (body: SimulationInput) => saveSimulation(simulation?.id ?? null, body),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "simulator"] });
      onSaved(saved.id);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!brand || !route) return;
    if (!name.trim()) return setProblem(t("simulator.form.nameNeeded"));
    const wrongId = simIdProblem(brand.idFormat, identifier.trim());
    if (wrongId) return setProblem(sayShared(wrongId));
    const serverPort = whole(port, 1, 65_535);
    if (!host.trim() || serverPort === null) return setProblem(sayShared({ key: "validation.simTargetNeeded" }));
    const intervalS = whole(interval, 1, 3600);
    if (intervalS === null) return setProblem(`${t("simulator.form.interval")}: ${t("simulator.form.intervalRange")}`);
    const cruiseKmh = whole(speed, 5, 200);
    if (cruiseKmh === null) return setProblem(`${t("simulator.form.speed")}: ${t("simulator.form.speedRange")}`);
    const idleS = whole(idle, 0, 86_400);
    const restS = whole(rest, 0, 86_400);
    if (idleS === null) return setProblem(`${t("simulator.form.idle")}: ${t("simulator.form.pauseRange")}`);
    if (restS === null) return setProblem(`${t("simulator.form.rest")}: ${t("simulator.form.pauseRange")}`);
    const made = scenarioOf(options, route.lengthM);
    if ("problem" in made) {
      const text = t(`simulator.options.problem.${made.problem.key}`);
      return setProblem(made.problem.row ? t("simulator.options.problemRow", { row: made.problem.row, problem: text }) : text);
    }
    setProblem(null);
    save.mutate({
      name: name.trim(),
      modelId,
      identifiers: [identifier.trim()],
      host: host.trim(),
      port: serverPort,
      intervalS,
      routeId,
      scenario: { cruiseKmh, end: shownEnd, idleS, restS, ...made.options },
    });
  };

  return (
    <Modal open onClose={onClose} title={simulation ? t("simulator.form.editTitle") : t("simulator.form.newTitle")} wide>
      <form onSubmit={submit} className="space-y-5" noValidate>
        {simulation?.running && <Notice>{t("simulator.form.restartNote")}</Notice>}
        <Field label={t("simulator.form.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("simulator.form.namePlaceholder")} autoFocus />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1.4fr]">
          <div>
            <label htmlFor="sim-brand" className={labelClass}>
              {t("simulator.form.brand")}
            </label>
            <select id="sim-brand" className={`${selectClass} h-11 w-full`} value={modelId} onChange={(e) => changeBrand(e.target.value)}>
              {meta.brands.map((b) => (
                <option key={b.modelId} value={b.modelId}>
                  {b.brand}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-start gap-2">
            <Field
              className="min-w-0 flex-1"
              label={t("simulator.form.identifier", { label: brand?.idLabel ?? "ID" })}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              mono
              maxLength={20}
              hint={brand?.idFormat.kind === "imei" ? t("simulator.form.hintImei") : brand ? t("simulator.form.hintDigits", { length: brand.idFormat.length }) : undefined}
            />
            {/* Lined up with the field, below its label. */}
            <Button type="button" variant="secondary" className="mt-[26px] h-11 shrink-0" onClick={() => brand && setIdentifier(generateSimId(brand.idFormat))}>
              <Dices size={16} aria-hidden="true" />
              {t("simulator.form.generate")}
            </Button>
          </div>
        </div>

        <div>
          <p className={labelClass}>{t("simulator.form.connection")}</p>
          <div className="grid grid-cols-[1fr_7.5rem] gap-3">
            <Field label={t("simulator.form.server")} value={host} onChange={(e) => setHost(e.target.value.trim())} mono maxLength={253} placeholder={meta.host} />
            <Field label={t("simulator.form.port")} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric" mono maxLength={5} placeholder={String(brand?.port ?? "")} />
          </div>
          <p className="mt-2 text-[13px] text-muted">{t("simulator.form.connectionNote")}</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1.4fr_1fr]">
          <div>
            <label htmlFor="sim-route" className={labelClass}>
              {t("simulator.form.route")}
            </label>
            <select id="sim-route" className={`${selectClass} h-11 w-full`} value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {t("simulator.form.routeOption", { name: r.name, km: formatKm(r.lengthM) })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sim-end" className={labelClass}>
              {t("simulator.form.end")}
            </label>
            <select id="sim-end" className={`${selectClass} h-11 w-full`} value={shownEnd} onChange={(e) => setEnd(e.target.value as SimEnd)}>
              {ends.map((id) => (
                <option key={id} value={id}>
                  {t(`simulator.form.endOption.${id}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 items-end gap-4 sm:grid-cols-4">
          <Field label={t("simulator.form.speed")} value={speed} onChange={(e) => setSpeed(e.target.value.replace(/\D/g, ""))} inputMode="numeric" mono maxLength={3} />
          <Field label={t("simulator.form.interval")} value={interval} onChange={(e) => setInterval(e.target.value.replace(/\D/g, ""))} inputMode="numeric" mono maxLength={4} />
          <Field label={t("simulator.form.idle")} value={idle} onChange={(e) => setIdle(e.target.value.replace(/\D/g, ""))} inputMode="numeric" mono maxLength={5} />
          <Field label={t("simulator.form.rest")} value={rest} onChange={(e) => setRest(e.target.value.replace(/\D/g, ""))} inputMode="numeric" mono maxLength={5} />
        </div>
        <p className="-mt-2 text-[13px] text-muted">
          {route?.timed && `${t("simulator.form.timedHint")} `}
          {t("simulator.form.restHint")}
        </p>

        {brand && route && <ScenarioOptions draft={options} onChange={setOptions} brand={brand} route={route} />}

        {(problem || save.isError) && <Notice tone="error">{problem ?? errorText(save.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!brand || !route}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
