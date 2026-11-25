// API client for the notifications by channel: those of the account, the
// platform's own and the test of each channel.
import type { AccountNotification, AccountNotificationInput, Delivery, NotificationOptions, NotifyChannel, SystemNotification, SystemNotificationInput } from "@opengps/shared";
import { api } from "./api";

const BASE = "/api/notifications";

export const getNotifications = () => api<{ notifications: AccountNotification[]; options: NotificationOptions }>(BASE);
export const saveNotification = (id: string | null, body: AccountNotificationInput) =>
  api<{ notifications: AccountNotification[] }>(id ? `${BASE}/${id}` : BASE, { method: id ? "PUT" : "POST", body }).then((r) => r.notifications);
export const deleteNotification = (id: string) => api<null>(`${BASE}/${id}`, { method: "DELETE" });
export const testNotification = (id: string) => api<{ deliveries: Delivery[] }>(`${BASE}/${id}/test`, { method: "POST", body: {} }).then((r) => r.deliveries);
export const getDeliveries = () => api<{ deliveries: Delivery[] }>(`${BASE}/deliveries`).then((r) => r.deliveries);

// ─── Platform ────────────────────────────────────────────────────────────────

const ADMIN = "/api/admin/notifications";

/** Sends a test message through a channel, with what is saved. */
export const testChannel = (channel: NotifyChannel, to: string) => api<{ sentTo: string }>(`/api/admin/channels/${channel}/test`, { method: "POST", body: { to } });
export const getSystemNotifications = () => api<{ notifications: SystemNotification[]; deliveries: Delivery[] }>(ADMIN);
export const saveSystemNotification = (id: string | null, body: SystemNotificationInput) =>
  api<{ notifications: SystemNotification[] }>(id ? `${ADMIN}/${id}` : ADMIN, { method: id ? "PUT" : "POST", body }).then((r) => r.notifications);
export const deleteSystemNotification = (id: string) => api<null>(`${ADMIN}/${id}`, { method: "DELETE" });
export const testSystemNotification = (id: string) => api<{ deliveries: Delivery[] }>(`${ADMIN}/${id}/test`, { method: "POST", body: {} }).then((r) => r.deliveries);
