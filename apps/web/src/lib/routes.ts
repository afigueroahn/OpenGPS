// API client for module H · Routes and logistics.
import type { DeliveryView, DriverTripView, NearbyVehicle, Poi, PoiInput, RoutePlan, RoutePlanInput, RouteProofKind, RouteStopStatus, RouteTrip, RouteTripInput } from "@opengps/shared";
import { ApiRequestError, api } from "./api";
import i18n from "./i18n";

const BASE = "/api/routes";

export const getPois = () => api<{ pois: Poi[] }>(`${BASE}/pois`).then((r) => r.pois);
export const savePoi = (id: string | null, body: PoiInput) => api<{ pois: Poi[] }>(id ? `${BASE}/pois/${id}` : `${BASE}/pois`, { method: id ? "PUT" : "POST", body }).then((r) => r.pois);
export const deletePoi = (id: string) => api<null>(`${BASE}/pois/${id}`, { method: "DELETE" });

export const getRoutePlans = () => api<{ plans: RoutePlan[] }>(`${BASE}/plans`).then((r) => r.plans);
export const saveRoutePlan = (id: string | null, body: RoutePlanInput) => api<{ plans: RoutePlan[] }>(id ? `${BASE}/plans/${id}` : `${BASE}/plans`, { method: id ? "PUT" : "POST", body }).then((r) => r.plans);
export const deleteRoutePlan = (id: string) => api<null>(`${BASE}/plans/${id}`, { method: "DELETE" });
/** The path a vehicle took over a period, to use as a route. */
export const getRouteLine = (vehicleId: string, from: Date, to: Date) =>
  api<{ line: [number, number][]; lengthM: number }>(`${BASE}/line?vehicleId=${vehicleId}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);

export const getNearest = (lat: number, lon: number) => api<{ vehicles: NearbyVehicle[] }>(`${BASE}/nearest?lat=${lat}&lon=${lon}`).then((r) => r.vehicles);
export const getRouteTrips = () => api<{ trips: RouteTrip[] }>(`${BASE}/trips`).then((r) => r.trips);
export const createRouteTrip = (body: RouteTripInput) => api<{ trip: RouteTrip }>(`${BASE}/trips`, { method: "POST", body }).then((r) => r.trip);
export const setRouteTripStatus = (id: string, status: "in_progress" | "done" | "cancelled") => api<{ trip: RouteTrip }>(`${BASE}/trips/${id}/status`, { method: "PUT", body: { status } }).then((r) => r.trip);
export const deleteRouteTrip = (id: string) => api<null>(`${BASE}/trips/${id}`, { method: "DELETE" });
export const createDriverLink = (tripId: string) => api<{ token: string }>(`${BASE}/trips/${tripId}/link`, { method: "POST" }).then((r) => r.token);
export const updateRouteStop = (stopId: string, body: { status: RouteStopStatus; recipient: string | null; note: string | null }) => api<{ trip: RouteTrip }>(`${BASE}/stops/${stopId}`, { method: "PUT", body }).then((r) => r.trip);
export const createTrackLink = (stopId: string) => api<{ token: string }>(`${BASE}/stops/${stopId}/link`, { method: "POST" }).then((r) => r.token);
export const proofUrl = (stopId: string, kind: RouteProofKind) => `${BASE}/stops/${stopId}/proof/${kind}`;

/** URLs of the public pages: the key goes after the hash, so the browser does not send it when requesting the page. */
export const driverPageUrl = (token: string) => `${window.location.origin}/driver#${token}`;
export const trackPageUrl = (token: string) => `${window.location.origin}/delivery#${token}`;

// ─── With the link, no session ───────────────────────────────────────────────

export const viewDriverTrip = (token: string) => api<{ view: DriverTripView }>(`${BASE}/driver/view`, { method: "POST", body: { token } }).then((r) => r.view);
export const setDriverTripStatus = (token: string, status: "in_progress" | "done") => api<{ view: DriverTripView }>(`${BASE}/driver/status`, { method: "POST", body: { token, status } }).then((r) => r.view);
export const setDriverStop = (token: string, stopId: string, body: { status: "arrived" | "done" | "failed"; recipient: string | null; note: string | null }) =>
  api<{ view: DriverTripView }>(`${BASE}/driver/stop`, { method: "POST", body: { token, stopId, ...body } }).then((r) => r.view);
/** Uploads the photo or signature of a delivery. The link key goes in a header, not in the URL. */
export async function uploadProof(token: string, stopId: string, kind: RouteProofKind, image: Blob): Promise<DriverTripView> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/driver/proof?stopId=${stopId}&kind=${kind}`, { method: "POST", headers: { "Content-Type": image.type || "image/jpeg", "X-Route-Token": token }, body: image });
  } catch {
    throw new ApiRequestError(0, "network", i18n.t("map.errors.imageNetwork"));
  }
  const data = (await response.json().catch(() => null)) as { view?: DriverTripView; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !data?.view) throw new ApiRequestError(response.status, data?.error?.code ?? "error", data?.error?.message ?? i18n.t("map.errors.imageSave"));
  return data.view;
}
export const viewDelivery = (token: string) => api<{ view: DeliveryView }>(`${BASE}/track/view`, { method: "POST", body: { token } }).then((r) => r.view);
