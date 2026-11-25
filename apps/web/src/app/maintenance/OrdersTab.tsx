// Work orders: preventive and corrective, with their status and cost.
// Filtered by vehicle they are its repair history.
import type { MaintOrder, MaintOrderStatus } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Paperclip, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../../components/ui";
import { getMaintOrders } from "../../lib/maintenance";
import { dayLabel, money } from "../fleet/format";
import { Card, Tile, selectClass } from "../reports/kit";
import { errorText } from "../widgets";
import { OrderDialog, type OrderDraft } from "./OrderDialog";

const STATUS_STYLE: Record<MaintOrderStatus, string> = {
  open: "bg-stopped/10 text-[#2a5c9e]",
  in_progress: "bg-idle/15 text-[#8a5a00]",
  done: "bg-moving/10 text-signal-ink",
  cancelled: "border border-line bg-canvas text-muted",
};
export function OrderStatusBadge({ status }: { status: MaintOrderStatus }) {
  const { t } = useTranslation();
  return <span className={clsx("inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold", STATUS_STYLE[status])}>{t(`shared.maintOrderStatus.${status}`)}</span>;
}

export function OrdersTab(props: { vehicles: { id: string; name: string }[]; canManage: boolean; draft: OrderDraft | null; onDraftUsed: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState("all");
  const [vehicleId, setVehicleId] = useState("all");
  const [open, setOpen] = useState<{ order: MaintOrder | null; draft: OrderDraft | null } | null>(null);
  const orders = useQuery({
    queryKey: ["maintenance", "orders", status, vehicleId],
    queryFn: () => getMaintOrders({ ...(status === "all" ? {} : { status }), ...(vehicleId === "all" ? {} : { vehicleId }) }),
  });

  // When arriving from a pending service its order opens, already with the vehicle and the service.
  const { draft, onDraftUsed } = props;
  useEffect(() => {
    if (!draft) return;
    setOpen({ order: null, draft });
    onDraftUsed();
  }, [draft, onDraftUsed]);

  const list = orders.data ?? [];
  const done = list.filter((o) => o.status === "done");
  const pending = list.filter((o) => o.status === "open" || o.status === "in_progress").length;
  const spent = new Map<string, number>();
  for (const o of done) spent.set(o.currency, (spent.get(o.currency) ?? 0) + o.total);
  const totals = [...spent].sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight">{t("maintenance.orders.title")}</h1>
            <p className="mt-0.5 text-sm text-muted">{t("maintenance.orders.lead")}</p>
          </div>
          {props.canManage && (
            <Button size="sm" onClick={() => setOpen({ order: null, draft: null })} disabled={props.vehicles.length === 0}>
              <Plus size={15} aria-hidden="true" /> {t("maintenance.orders.new")}
            </Button>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <select aria-label={t("maintenance.orders.status")} value={status} onChange={(e) => setStatus(e.target.value)} className={clsx(selectClass, "flex-1 basis-40 sm:flex-none")}>
            <option value="all">{t("maintenance.orders.filter.all")}</option>
            <option value="pending">{t("maintenance.orders.filter.pending")}</option>
            <option value="done">{t("maintenance.orders.filter.done")}</option>
            <option value="cancelled">{t("maintenance.orders.filter.cancelled")}</option>
          </select>
          <select aria-label={t("common.vehicle")} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={clsx(selectClass, "max-w-full flex-1 basis-48 sm:flex-none")}>
            <option value="all">{t("maintenance.orders.allVehicles")}</option>
            {props.vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {orders.isError && <Notice tone="error">{errorText(orders.error)}</Notice>}
      {orders.isLoading && (
        <div className="flex h-40 items-center justify-center text-muted">
          <Spinner size={22} />
        </div>
      )}
      {orders.data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Tile raised label={t("maintenance.orders.tiles.pending")} value={String(pending)} foot={t("maintenance.orders.tiles.pendingFoot")} />
            <Tile raised label={t("maintenance.orders.tiles.done")} value={String(done.length)} foot={t("maintenance.orders.tiles.doneFoot")} />
            <Tile raised label={t("maintenance.orders.tiles.cost")} value={totals.length ? totals.map(([currency, total]) => money(total, currency)).join(" · ") : "—"} />
          </div>
          <Card>
            {list.length === 0 ? (
              <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{props.canManage ? t("maintenance.orders.emptyManage") : t("maintenance.orders.empty")}</p>
            ) : (
              <ul className="-m-4 divide-y divide-line">
                {list.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => setOpen({ order: o, draft: null })} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70">
                      <span className="num hidden w-12 shrink-0 text-[13px] text-muted sm:block">{t("maintenance.orders.number", { n: o.number })}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[14.5px] font-medium text-ink">{o.title}</span>
                          <span className="truncate text-[13px] text-ink-3">{o.vehicleName}</span>
                        </span>
                        <span className="block truncate text-[12.5px] text-muted">
                          {t(`shared.maintOrderKind.${o.kind}`)} · <span className="num">{dayLabel(o.doneOn ?? o.openedOn)}</span>
                          {o.workshopName && <> · {o.workshopName}</>}
                          {o.planName && <> · {o.planName}</>}
                          {o.files.length > 0 && (
                            <>
                              {" "}
                              · <Paperclip size={12} className="inline-block align-[-1px]" aria-label={t("maintenance.orders.attachments")} /> {o.files.length}
                            </>
                          )}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <OrderStatusBadge status={o.status} />
                        {o.total > 0 && <span className="num text-[13px] font-semibold text-ink">{money(o.total, o.currency)}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {open && <OrderDialog order={open.order} draft={open.draft} vehicles={props.vehicles} canManage={props.canManage} onClose={() => setOpen(null)} onChanged={() => undefined} />}
    </div>
  );
}
