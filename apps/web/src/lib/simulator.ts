// API client for the device simulator of the admin console.
import type { LonLat, SimInjectInput, SimPlace, SimRoute, SimRouteInput, SimRouteSummary, SimTrace, SimulationDetail, SimulationInput, SimulationSummary, SimulatorMeta } from "@opengps/shared";
import { api } from "./api";

const BASE = "/api/admin/simulator";

export const getSimulatorMeta = () => api<{ meta: SimulatorMeta }>(`${BASE}/meta`).then((r) => r.meta);
export const getSimRoutes = () => api<{ routes: SimRouteSummary[] }>(`${BASE}/routes`).then((r) => r.routes);
export const getSimRoute = (id: string) => api<{ route: SimRoute }>(`${BASE}/routes/${id}`).then((r) => r.route);
export const saveSimRoute = (id: string | null, body: SimRouteInput) => api<{ route: SimRoute }>(id ? `${BASE}/routes/${id}` : `${BASE}/routes`, { method: id ? "PUT" : "POST", body }).then((r) => r.route);
export const deleteSimRoute = (id: string) => api<null>(`${BASE}/routes/${id}`, { method: "DELETE" });
/** The path along streets through those points, from the routing service. */
export const traceSimRoute = (points: { lon: number; lat: number }[]) => api<{ trace: SimTrace }>(`${BASE}/route-line`, { method: "POST", body: { points } }).then((r) => r.trace);
/** The path one of the owner's own vehicles took over a period. */
export const getSimTripLine = (vehicleId: string, from: Date, to: Date) =>
  api<{ line: LonLat[]; lengthM: number }>(`${BASE}/trip-line?vehicleId=${vehicleId}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
/** Places that match a written address. Asked when the person sends the search, never while they type. */
export const searchSimPlaces = (q: string) => api<{ places: SimPlace[] }>(`${BASE}/places?q=${encodeURIComponent(q)}`).then((r) => r.places);
export const getSimulations = () => api<{ simulations: SimulationSummary[] }>(`${BASE}/simulations`).then((r) => r.simulations);
export const getSimulation = (id: string) => api<{ simulation: SimulationDetail }>(`${BASE}/simulations/${id}`).then((r) => r.simulation);
export const saveSimulation = (id: string | null, body: SimulationInput) =>
  api<{ simulation: SimulationDetail }>(id ? `${BASE}/simulations/${id}` : `${BASE}/simulations`, { method: id ? "PUT" : "POST", body }).then((r) => r.simulation);
export const deleteSimulation = (id: string) => api<null>(`${BASE}/simulations/${id}`, { method: "DELETE" });
export const runSimulation = (id: string, run: boolean) => api<{ simulation: SimulationDetail }>(`${BASE}/simulations/${id}/run`, { method: "POST", body: { run } }).then((r) => r.simulation);
export const runAllSimulations = (run: boolean) => api<{ simulations: SimulationSummary[] }>(`${BASE}/run`, { method: "POST", body: { run } }).then((r) => r.simulations);
/** Does something by hand to a running simulation's devices. */
export const injectSimulation = (id: string, body: SimInjectInput) => api<{ simulation: SimulationDetail }>(`${BASE}/simulations/${id}/inject`, { method: "POST", body }).then((r) => r.simulation);
/** Sends its whole route as a trip that ended that many hours ago. */
export const backfillSimulation = (id: string, hoursAgo: number) => api<{ simulation: SimulationDetail; reports: number }>(`${BASE}/simulations/${id}/backfill`, { method: "POST", body: { hoursAgo } });
