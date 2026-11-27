// Unlocking the app with Face ID (ADR-0019): when the app asks for it again.

/** Time away after which the app asks for Face ID again. */
export const LOCK_AFTER_MS = 5 * 60_000;

/**
 * Whether the app asks for Face ID when it comes back, having gone to the background at `leftAt`. null = it did not
 * go: the system's own Face ID prompt only makes the app inactive for a moment.
 */
export const locksOnReturn = (leftAt: number | null, now: number): boolean => leftAt !== null && now - leftAt >= LOCK_AFTER_MS;
