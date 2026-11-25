// Shared location.

/** Durations offered for a link, in hours. */
export const SHARE_DURATIONS = [1, 8, 24, 72, 168] as const;
/** The longest a link can last: 30 days. */
export const SHARE_MAX_HOURS = 30 * 24;
/** Active links a vehicle can have at once. */
export const SHARE_MAX_ACTIVE = 20;

/** Link as the account sees it. The full URL exists only when it is created. */
export interface ShareLink {
  id: string;
  vehicleId: string;
  note: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** Times someone opened the link. */
  views: number;
  lastViewedAt: string | null;
}

/** What whoever opens a link sees: just enough to know where the vehicle is. */
export interface SharedView {
  name: string;
  expiresAt: string;
  status: "moving" | "stopped" | "offline" | "unknown";
  position: { lat: number; lon: number; speedKmh: number; course: number | null; fixTime: string } | null;
  lastSeenAt: string | null;
}
