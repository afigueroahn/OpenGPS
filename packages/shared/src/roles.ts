// Roles and permissions.
import { es } from "./locales/es";

/** What a role can do in addition to seeing the vehicles in its scope. What each one allows is in the catalog: "permission.<permission>". */
const PERMISSION_KEYS = [
  "vehicles.manage",
  "geofences.manage",
  "alerts.manage",
  "links.share",
  "commands.send",
  "incidents.manage",
  "drivers.manage",
  "reports.schedule",
  "members.manage",
  "audit.view",
  "notifications.manage",
  "integrations.manage",
] as const;
export type Permission = (typeof PERMISSION_KEYS)[number];
export const ALL_PERMISSIONS: Permission[] = [...PERMISSION_KEYS];

export interface RoleInfo {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  builtin: boolean;
}

/**
 * Roles the platform comes with. The owner is whoever created the account and is not assigned.
 * Their `name` and `description` are Spanish only and will go: use the catalog, "role.<id>" and "roleDescription.<id>".
 */
export const BUILTIN_ROLES: RoleInfo[] = [
  { id: "admin", name: es.role.admin, description: es.roleDescription.admin, permissions: ALL_PERMISSIONS, builtin: true },
  { id: "operator", name: es.role.operator, description: es.roleDescription.operator, permissions: ["vehicles.manage", "geofences.manage", "alerts.manage", "links.share", "incidents.manage", "drivers.manage", "reports.schedule"], builtin: true },
  { id: "viewer", name: es.role.viewer, description: es.roleDescription.viewer, permissions: [], builtin: true },
];
/** Its `name` and `description` are Spanish only and will go: use the catalog, "role.owner" and "roleDescription.owner". */
export const OWNER_ROLE: RoleInfo = { id: "owner", name: es.role.owner, description: es.roleDescription.owner, permissions: ALL_PERMISSIONS, builtin: true };

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  roleName: string;
  /** Groups it can see; null = all. */
  groups: string[] | null;
  /** Vehicles it sees one by one, besides those of its groups. */
  vehicles: string[];
  disabled: boolean;
  joinedAt: string;
  isYou: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  roleName: string;
  groups: string[] | null;
  vehicles: string[];
  expiresAt: string;
}

export interface InvitationPreview {
  accountName: string;
  email: string;
  inviterName: string;
  roleName: string;
  status: "pending" | "expired" | "accepted" | "canceled";
}

export interface AuditEntry {
  id: number;
  at: string;
  userName: string | null;
  action: string;
  entity: string | null;
  detail: Record<string, unknown>;
}
