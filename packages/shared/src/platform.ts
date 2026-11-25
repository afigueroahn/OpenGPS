// Platform admin console.
import { ALL_MODULES, type ModuleKey } from "./modules";
import type { SignInMethod } from "./oauth";
import { z } from "zod";

export interface AccountLimits {
  /** null = no limit. */
  maxVehicles: number | null;
  maxUsers: number | null;
}

export interface AdminAccount {
  id: string;
  name: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** How the owner last signed in; null if never seen. */
  ownerSignInMethod: SignInMethod | null;
  /** When the owner last used the platform. */
  ownerLastAccessAt: string | null;
  createdAt: string;
  users: number;
  vehicles: number;
  /** Devices that have already reported. */
  activeDevices: number;
  lastSeenAt: string | null;
  suspended: boolean;
  suspendedReason: string | null;
  limits: AccountLimits;
  modules: ModuleKey[];
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  /** Administers the whole platform: they are neither suspended nor deleted. */
  platformOwner: boolean;
  /** How they last signed in; null if never seen. */
  signInMethod: SignInMethod | null;
  /** When they last used the platform. */
  lastAccessAt: string | null;
}

export interface AdminAccountDetail extends AdminAccount {
  members: AdminUser[];
  /** Its owner administers the whole platform: the account is not deleted. */
  ownedByPlatformOwner: boolean;
}

/** What the administration panel shows of one account at a glance. */
export interface AccountSummary {
  vehicles: number;
  /** Vehicles whose device reported in the last 10 minutes. */
  reportingNow: number;
  users: number;
  /** Events of the last 24 hours. */
  events24h: number;
}

export interface PlatformStats {
  accounts: number;
  suspendedAccounts: number;
  users: number;
  vehicles: number;
  activeDevices: number;
  pendingDevices: number;
  /** Devices that reported in the last 10 minutes. */
  reportingNow: number;
  positionsToday: number;
  diskUsedPercent: number | null;
}

export const accountAdminSchema = z.object({
  suspended: z.boolean().optional(),
  suspendedReason: z.string().trim().max(200).optional(),
  maxVehicles: z.number().int().min(0).max(100_000).nullable().optional(),
  maxUsers: z.number().int().min(1).max(10_000).nullable().optional(),
  modules: z.array(z.enum(ALL_MODULES as [ModuleKey, ...ModuleKey[]])).optional(),
});
export type AccountAdminInput = z.input<typeof accountAdminSchema>;
