// API client for module I · Integrations.
import type { ApiKey, Automation, AutomationInput, AutomationRun, ImportResult, Sensor, SensorInput, SensorSeries, TransferFormat, TransferKind, Webhook, WebhookDelivery, WebhookInput } from "@opengps/shared";
import { api } from "./api";

const BASE = "/api/integrations";

export const getApiKeys = () => api<{ keys: ApiKey[] }>(`${BASE}/keys`).then((r) => r.keys);
/** `secret` is the full key: it only arrives here, when it is created. */
export const createApiKey = (body: { name: string; canWrite: boolean }) => api<{ keys: ApiKey[]; secret: string }>(`${BASE}/keys`, { method: "POST", body });
export const revokeApiKey = (id: string) => api<null>(`${BASE}/keys/${id}`, { method: "DELETE" });

export const getWebhooks = () => api<{ webhooks: Webhook[] }>(`${BASE}/webhooks`).then((r) => r.webhooks);
export const createWebhook = (body: WebhookInput) => api<{ webhooks: Webhook[]; secret: string }>(`${BASE}/webhooks`, { method: "POST", body });
export const updateWebhook = (id: string, body: WebhookInput) => api<{ webhooks: Webhook[] }>(`${BASE}/webhooks/${id}`, { method: "PUT", body }).then((r) => r.webhooks);
export const deleteWebhook = (id: string) => api<null>(`${BASE}/webhooks/${id}`, { method: "DELETE" });
export const rotateWebhookSecret = (id: string) => api<{ secret: string }>(`${BASE}/webhooks/${id}/secret`, { method: "POST" }).then((r) => r.secret);
export const getWebhookDeliveries = (id: string) => api<{ deliveries: WebhookDelivery[] }>(`${BASE}/webhooks/${id}/deliveries`).then((r) => r.deliveries);
export const testWebhook = (id: string) => api<{ deliveries: WebhookDelivery[] }>(`${BASE}/webhooks/${id}/test`, { method: "POST" }).then((r) => r.deliveries);

export const getAutomations = () => api<{ automations: Automation[] }>(`${BASE}/automations`).then((r) => r.automations);
export const saveAutomation = (id: string | null, body: AutomationInput) =>
  api<{ automations: Automation[] }>(id ? `${BASE}/automations/${id}` : `${BASE}/automations`, { method: id ? "PUT" : "POST", body }).then((r) => r.automations);
export const deleteAutomation = (id: string) => api<null>(`${BASE}/automations/${id}`, { method: "DELETE" });
export const getAutomationRuns = (id: string) => api<{ runs: AutomationRun[] }>(`${BASE}/automations/${id}/runs`).then((r) => r.runs);

export const getSensors = () => api<{ sensors: Sensor[] }>(`${BASE}/sensors`).then((r) => r.sensors);
export const createSensor = (body: SensorInput) => api<{ sensors: Sensor[]; secret: string }>(`${BASE}/sensors`, { method: "POST", body });
export const updateSensor = (id: string, body: SensorInput) => api<{ sensors: Sensor[] }>(`${BASE}/sensors/${id}`, { method: "PUT", body }).then((r) => r.sensors);
export const deleteSensor = (id: string) => api<null>(`${BASE}/sensors/${id}`, { method: "DELETE" });
export const rotateSensorKey = (id: string) => api<{ secret: string }>(`${BASE}/sensors/${id}/key`, { method: "POST" }).then((r) => r.secret);
export const getSensorSeries = (id: string, from: Date, to: Date) =>
  api<{ series: SensorSeries }>(`${BASE}/sensors/${id}/readings?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`).then((r) => r.series);

export const exportUrl = (kind: TransferKind, format: TransferFormat) => `${BASE}/export/${kind}?format=${format}`;
export const importCsv = (kind: TransferKind, csv: string) => api<{ result: ImportResult }>(`${BASE}/import/${kind}`, { method: "POST", body: { csv } }).then((r) => r.result);

/** Where this installation's public API lives. */
export const apiBase = () => `${window.location.origin}/api/v1`;
