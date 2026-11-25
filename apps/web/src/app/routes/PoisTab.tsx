// Points of interest: the places the account visits. They serve as stops when
// planning and dispatching, and give names to places in reports.
import { POI_CATEGORIES, type Poi, type PoiCategory, type PoiInput, type Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, Search, Trash } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { deletePoi, getPois, savePoi } from "../../lib/routes";
import { Card, selectClass } from "../reports/kit";
import { errorText } from "../widgets";
import { RouteMap } from "./RouteMap";

const select = "h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
const label = "mb-1.5 block text-[13px] font-medium text-ink-3";

export function PoisTab({ vehicles, canManage }: { vehicles: Vehicle[]; canManage: boolean }) {
  const { t } = useTranslation();
  const pois = useQuery({ queryKey: ["routes", "pois"], queryFn: getPois });
  const [editing, setEditing] = useState<Poi | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | PoiCategory>("all");
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (pois.data ?? []).filter((p) => (category === "all" || p.category === category) && (!term || `${p.name} ${p.address ?? ""}`.toLowerCase().includes(term)));
  }, [pois.data, search, category]);
  return (
    <div className="space-y-4">
      <Card
        title={t("routes.pois.title")}
        note={t("routes.pois.note")}
        action={
          canManage ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden="true" /> {t("routes.pois.new")}
            </Button>
          ) : undefined
        }
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <label className="flex h-10 min-w-0 flex-1 basis-56 items-center gap-2 rounded-[10px] border border-line px-3 text-muted focus-within:border-ink">
            <Search size={15} className="shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("routes.pois.search")} aria-label={t("routes.pois.searchLabel")} className="h-full w-full min-w-0 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none" />
          </label>
          <select aria-label={t("routes.pois.category")} value={category} onChange={(e) => setCategory(e.target.value as "all" | PoiCategory)} className={selectClass}>
            <option value="all">{t("routes.pois.allCategories")}</option>
            {POI_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`shared.poiCategory.${c}`)}
              </option>
            ))}
          </select>
        </div>
        {pois.isLoading && (
          <div className="flex h-24 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {pois.isError && <Notice tone="error">{errorText(pois.error)}</Notice>}
        {pois.data &&
          (pois.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">{canManage ? t("routes.pois.emptyManage") : t("routes.pois.empty")}</p>
          ) : shown.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("routes.pois.noMatch")}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {shown.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => setEditing(p)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-canvas/70">
                    <MapPin size={17} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">{p.name}</span>
                      <span className="block truncate text-[12.5px] text-muted">{[t(`shared.poiCategory.${p.category}`), p.address, p.phone].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="num hidden shrink-0 text-[12px] text-muted sm:block">
                      {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>
      {editing && <PoiDialog poi={editing === "new" ? null : editing} vehicles={vehicles} canManage={canManage} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** "14.0818, -87.2068", as maps give it when copying a point. */
function parseCoords(text: string): { lat: number; lon: number } | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = Number((m[1] as string).replace(",", "."));
  const lon = Number((m[2] as string).replace(",", "."));
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function PoiDialog({ poi, vehicles, canManage, onClose }: { poi: Poi | null; vehicles: Vehicle[]; canManage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(poi?.name ?? "");
  const [category, setCategory] = useState<PoiCategory>(poi?.category ?? "client");
  const [point, setPoint] = useState<{ lat: number; lon: number } | null>(poi ? { lat: poi.lat, lon: poi.lon } : null);
  const [coords, setCoords] = useState(poi ? `${poi.lat}, ${poi.lon}` : "");
  const [radius, setRadius] = useState(String(poi?.radiusM ?? 100));
  const [address, setAddress] = useState(poi?.address ?? "");
  const [phone, setPhone] = useState(poi?.phone ?? "");
  const [notes, setNotes] = useState(poi?.notes ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [fit, setFit] = useState(0);
  const done = (next?: Poi[]) => {
    if (next) queryClient.setQueryData(["routes", "pois"], next);
    else void queryClient.invalidateQueries({ queryKey: ["routes", "pois"] });
    onClose();
  };
  const save = useMutation({ mutationFn: (body: PoiInput) => savePoi(poi?.id ?? null, body), onSuccess: done });
  const remove = useMutation({ mutationFn: () => deletePoi(poi?.id ?? ""), onSuccess: () => done() });
  const place = (lat: number, lon: number, refit = false) => {
    setPoint({ lat, lon });
    setCoords(`${lat}, ${lon}`);
    if (refit) setFit((n) => n + 1);
  };
  const located = vehicles.filter((v) => v.state?.lat != null && v.state.lon != null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = Number(radius);
    if (!name.trim()) return setProblem(t("routes.pois.needName"));
    if (!point) return setProblem(t("routes.pois.needPoint"));
    if (!Number.isInteger(r) || r < 20 || r > 2000) return setProblem(t("routes.pois.radiusRange"));
    setProblem(null);
    save.mutate({ name: name.trim(), category, lat: point.lat, lon: point.lon, radiusM: r, address: address || null, phone: phone || null, notes: notes || null });
  };
  return (
    <Modal open onClose={onClose} title={poi ? poi.name : t("routes.pois.newTitle")} wide>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <fieldset disabled={!canManage} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.6fr_1fr]">
            <Field label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("routes.pois.namePlaceholder")} />
            <div>
              <label htmlFor="lugar-categoria" className={label}>
                {t("routes.pois.category")}
              </label>
              <select id="lugar-categoria" value={category} onChange={(e) => setCategory(e.target.value as PoiCategory)} className={select}>
                {POI_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`shared.poiCategory.${c}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <span className={label}>{t("routes.pois.where")}</span>
            <RouteMap points={point ? [{ ...point, color: "#cf3a32" }] : []} onPick={canManage ? (lat, lon) => place(lat, lon) : undefined} fitKey={fit} className="h-56" label={t("routes.pois.mapLabel")} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.6fr_1fr]">
            <Field
              label={t("routes.pois.coords")}
              value={coords}
              onChange={(e) => {
                setCoords(e.target.value);
                const p = parseCoords(e.target.value);
                if (p) {
                  setPoint(p);
                  setFit((n) => n + 1);
                }
              }}
              mono
              placeholder="14.0818, -87.2068"
              hint={t("routes.pois.coordsHint")}
            />
            <Field label={t("routes.pois.radius")} value={radius} onChange={(e) => setRadius(e.target.value)} inputMode="numeric" mono hint={t("routes.pois.radiusHint")} />
          </div>
          {canManage && located.length > 0 && (
            <div>
              <label htmlFor="lugar-vehiculo" className={label}>
                {t("routes.pois.fromVehicle")}
              </label>
              <select
                id="lugar-vehiculo"
                value=""
                onChange={(e) => {
                  const v = located.find((x) => x.id === e.target.value);
                  if (v?.state?.lat != null && v.state.lon != null) place(v.state.lat, v.state.lon, true);
                }}
                className={select}
              >
                <option value="">{t("routes.pois.pickVehicle")}</option>
                {located.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.6fr_1fr]">
            <Field label={t("routes.pois.address")} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
            <Field label={t("routes.pois.phone")} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} mono />
          </div>
          <Field label={t("routes.pois.notes")} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
        </fieldset>
        {(problem || save.isError || remove.isError) && <Notice tone="error">{problem ?? errorText(save.error ?? remove.error)}</Notice>}
        {canManage ? (
          <div className="flex items-center justify-between gap-2 pt-1">
            {poi ? (
              <Button type="button" variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                <Trash size={14} aria-hidden="true" /> {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={save.isPending}>
                {t("common.save")}
              </Button>
            </span>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
