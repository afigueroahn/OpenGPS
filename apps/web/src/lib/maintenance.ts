// API client for module E · Maintenance.
import type { MaintExpiryInput, MaintOrder, MaintOrderInput, MaintOverview, MaintPart, MaintPartInput, MaintPlan, MaintPlanInput, MaintSettings, MaintWorkshop, MaintWorkshopInput } from "@opengps/shared";
import { ApiRequestError, api, browserZone } from "./api";
import i18n from "./i18n";

const BASE = "/api/maintenance";
/** The clock of whoever is querying: "today" is counted with it. */
const zone = () => `zone=${encodeURIComponent(browserZone())}`;

export const getMaintenance = () => api<{ overview: MaintOverview }>(`${BASE}?${zone()}`).then((r) => r.overview);
export const getMaintSettings = () => api<{ settings: MaintSettings }>(`${BASE}/settings`).then((r) => r.settings);
export const saveMaintSettings = (body: MaintSettings) => api<{ settings: MaintSettings }>(`${BASE}/settings`, { method: "PUT", body: { ...body, zone: browserZone() } }).then((r) => r.settings);

export const getMaintPlans = () => api<{ plans: MaintPlan[] }>(`${BASE}/plans`).then((r) => r.plans);
export const saveMaintPlan = (id: string | null, body: MaintPlanInput) => api<{ plans: MaintPlan[] }>(`${id ? `${BASE}/plans/${id}` : `${BASE}/plans`}?${zone()}`, { method: id ? "PUT" : "POST", body }).then((r) => r.plans);
export const deleteMaintPlan = (id: string) => api<null>(`${BASE}/plans/${id}`, { method: "DELETE" });
export const setMaintBaseline = (scheduleId: string, body: { lastOn: string; lastKm: number | null; lastHours: number | null }) =>
  api<{ overview: MaintOverview }>(`${BASE}/schedules/${scheduleId}?${zone()}`, { method: "PUT", body }).then((r) => r.overview);

export const saveMaintExpiry = (id: string | null, body: MaintExpiryInput) =>
  api<{ overview: MaintOverview }>(`${id ? `${BASE}/expiries/${id}` : `${BASE}/expiries`}?${zone()}`, { method: id ? "PUT" : "POST", body }).then((r) => r.overview);
export const deleteMaintExpiry = (id: string) => api<{ overview: MaintOverview }>(`${BASE}/expiries/${id}?${zone()}`, { method: "DELETE" }).then((r) => r.overview);

export const getMaintOrders = (filter: { status?: string; vehicleId?: string } = {}) => {
  const query = new URLSearchParams();
  if (filter.status) query.set("status", filter.status);
  if (filter.vehicleId) query.set("vehicleId", filter.vehicleId);
  const text = query.toString();
  return api<{ orders: MaintOrder[] }>(`${BASE}/orders${text ? `?${text}` : ""}`).then((r) => r.orders);
};
export const saveMaintOrder = (id: string | null, body: MaintOrderInput) => api<{ order: MaintOrder }>(id ? `${BASE}/orders/${id}` : `${BASE}/orders`, { method: id ? "PUT" : "POST", body }).then((r) => r.order);
export const deleteMaintOrder = (id: string) => api<null>(`${BASE}/orders/${id}`, { method: "DELETE" });
export const maintFileUrl = (fileId: string) => `${BASE}/files/${fileId}`;
/** Uploads an attachment to an order. The file goes as is, with its type in the header. */
export async function uploadMaintFile(orderId: string, file: File): Promise<MaintOrder> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/orders/${orderId}/files?${new URLSearchParams({ name: file.name })}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  } catch {
    throw new ApiRequestError(0, "network", i18n.t("maintenance.errors.uploadNetwork"));
  }
  const data = (await response.json().catch(() => null)) as { order?: MaintOrder; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !data?.order) throw new ApiRequestError(response.status, data?.error?.code ?? "error", data?.error?.message ?? i18n.t("maintenance.errors.uploadType"));
  return data.order;
}
export const deleteMaintFile = (fileId: string) => api<{ order: MaintOrder }>(`${BASE}/files/${fileId}`, { method: "DELETE" }).then((r) => r.order);

export const getMaintWorkshops = () => api<{ workshops: MaintWorkshop[] }>(`${BASE}/workshops`).then((r) => r.workshops);
export const saveMaintWorkshop = (id: string | null, body: MaintWorkshopInput) =>
  api<{ workshops: MaintWorkshop[] }>(id ? `${BASE}/workshops/${id}` : `${BASE}/workshops`, { method: id ? "PUT" : "POST", body }).then((r) => r.workshops);
export const deleteMaintWorkshop = (id: string) => api<null>(`${BASE}/workshops/${id}`, { method: "DELETE" });

export const getMaintParts = () => api<{ parts: MaintPart[] }>(`${BASE}/parts`).then((r) => r.parts);
export const saveMaintPart = (id: string | null, body: MaintPartInput) => api<{ parts: MaintPart[] }>(id ? `${BASE}/parts/${id}` : `${BASE}/parts`, { method: id ? "PUT" : "POST", body }).then((r) => r.parts);
export const deleteMaintPart = (id: string) => api<null>(`${BASE}/parts/${id}`, { method: "DELETE" });
