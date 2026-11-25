// The sections of the panel and who sees each one. One panel for everybody:
// whoever administers the platform sees it whole, an account administrator
// sees their account's sections, and any member sees the overview, their
// profile and the modules their account has. The modules keep their own
// addresses (/fleet, /reports…), so links already sent still open them.
import type { Me, ModuleKey, Permission } from "@opengps/shared";
import {
  type LucideIcon,
  Activity,
  Bell,
  BellRing,
  Building2,
  CarFront,
  ChartColumn,
  ChartLine,
  DatabaseBackup,
  FolderTree,
  HardDrive,
  Home,
  KeyRound,
  Plug,
  Radar,
  RadioTower,
  Route,
  Settings2,
  ShieldCheck,
  User,
  Users,
  Wrench,
} from "lucide-react";

export const GROUPS = ["general", "modules", "account", "system"] as const;
export type SectionId =
  | "overview"
  | "fleet"
  | "maintenance"
  | "routes"
  | "reports"
  | "integrations"
  | "users"
  | "roles"
  | "vehicleGroups"
  | "notifications"
  | "activity"
  | "profile"
  | "accounts"
  | "settings"
  | "signIn"
  | "channels"
  | "systemNotifications"
  | "storage"
  | "backups"
  | "simulator"
  | "logs";

export interface Section {
  id: SectionId;
  /** What follows /admin/ in the address; empty for the overview, null for a module, which has an address of its own. */
  path: string | null;
  /** A module's own address. */
  href?: string;
  group: (typeof GROUPS)[number];
  icon: LucideIcon;
  /** Whether this person gets the section. */
  show: (who: Viewer) => boolean;
}

export interface Viewer {
  platformAdmin: boolean;
  can: (permission: Permission) => boolean;
  /** Sees every group of the account. */
  unrestricted: boolean;
  /** The modules the account has; none while it is suspended. */
  modules: readonly ModuleKey[];
}

export const viewerOf = (me: Me): Viewer => ({
  platformAdmin: me.user.platformAdmin,
  can: (permission) => me.account.permissions.includes(permission),
  unrestricted: me.account.groups === null,
  modules: me.account.suspended ? [] : me.account.modules,
});

const everyone = () => true;
const owner = (who: Viewer) => who.platformAdmin;
const module = (key: ModuleKey) => (who: Viewer) => who.modules.includes(key);

export const SECTIONS: Section[] = [
  { id: "overview", path: "", group: "general", icon: Home, show: everyone },
  { id: "fleet", path: null, href: "/fleet", group: "modules", icon: CarFront, show: module("D") },
  { id: "maintenance", path: null, href: "/maintenance", group: "modules", icon: Wrench, show: module("E") },
  { id: "routes", path: null, href: "/routes", group: "modules", icon: Route, show: module("H") },
  { id: "reports", path: null, href: "/reports", group: "modules", icon: ChartColumn, show: module("G") },
  { id: "integrations", path: null, href: "/integrations", group: "modules", icon: Plug, show: module("I") },
  { id: "users", path: "users", group: "account", icon: Users, show: (w) => w.can("members.manage") },
  { id: "roles", path: "roles", group: "account", icon: ShieldCheck, show: (w) => w.can("members.manage") },
  { id: "vehicleGroups", path: "groups", group: "account", icon: FolderTree, show: (w) => w.can("vehicles.manage") && w.unrestricted },
  { id: "notifications", path: "notifications", group: "account", icon: Bell, show: (w) => w.can("notifications.manage") },
  { id: "activity", path: "activity", group: "account", icon: Activity, show: (w) => w.can("audit.view") },
  { id: "profile", path: "profile", group: "account", icon: User, show: everyone },
  { id: "accounts", path: "system/accounts", group: "system", icon: Building2, show: owner },
  { id: "settings", path: "system/settings", group: "system", icon: Settings2, show: owner },
  { id: "signIn", path: "system/sign-in", group: "system", icon: KeyRound, show: owner },
  { id: "channels", path: "system/channels", group: "system", icon: RadioTower, show: owner },
  { id: "systemNotifications", path: "system/notifications", group: "system", icon: BellRing, show: owner },
  { id: "storage", path: "system/storage", group: "system", icon: HardDrive, show: owner },
  { id: "backups", path: "system/backups", group: "system", icon: DatabaseBackup, show: owner },
  { id: "simulator", path: "system/simulator", group: "system", icon: Radar, show: owner },
  { id: "logs", path: "system/logs", group: "system", icon: ChartLine, show: owner },
];

export const pathOf = (section: Section) => section.href ?? (section.path ? `/admin/${section.path}` : "/admin");

