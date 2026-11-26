// Incidents (module A): what needs someone to handle it. Their icons and
// colors, and the open ones the tab counts. Same as the web app's console
// (apps/web/src/app/security/IncidentsPanel.tsx).
import type { Incident, IncidentEntry, IncidentKind, IncidentResolution } from "@opengps/shared";
import { useQuery } from "@tanstack/react-query";
import { BatteryWarning, CircleParking, type LucideIcon, RadioTower, Siren, Truck, UserRound, Wrench } from "lucide-react-native";
import { getIncidents } from "./api";
import type { Palette } from "./theme";

export const INCIDENT_ICON: Record<IncidentKind, LucideIcon> = {
  sos: Siren,
  tow: Truck,
  tampering: Wrench,
  jamming: RadioTower,
  power_cut: BatteryWarning,
  movement: CircleParking,
  manual: UserRound,
};

export const statusColor = (status: Incident["status"], theme: Palette) => (status === "open" ? theme.danger : status === "attended" ? theme.warning : theme.muted);

export const entryColor = (kind: IncidentEntry["kind"], theme: Palette) =>
  kind === "alarm" || kind === "escalation" ? theme.danger : kind === "command" || kind === "recovery" ? theme.warning : kind === "status" ? theme.signalInk : theme.faint;

/** How an incident ended, as the web app proposes it: a panic button or a report is resolved; the rest, a false alarm. */
export const proposedResolution = (kind: IncidentKind): IncidentResolution => (kind === "sos" || kind === "manual" ? "resolved" : "false_alarm");

/** The incidents, open or all of them. The list and the tab's count share the open ones. */
export const useIncidents = (openOnly: boolean, enabled = true) =>
  useQuery({ queryKey: ["incidents", "list", openOnly], queryFn: () => getIncidents(openOnly), refetchInterval: 60_000, enabled });
