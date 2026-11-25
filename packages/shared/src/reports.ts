// Module G · Reports and dashboards.
import type { DriverRank } from "./drivers";
import type { EventType } from "./geofences";
import { es } from "./locales/es";
import type { ModuleKey } from "./modules";

export const REPORT_TYPES = ["trips", "stops", "mileage", "speed", "geofences", "alarms", "utilization", "drivers", "fuel", "maintenance"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
/** Each report, with the module needed in addition to the reports module for it to appear. */
export const REPORT_INFO: Record<
  ReportType,
  {
    /** @deprecated Spanish only. Use the catalog: "report.<type>". */
    label: string;
    /** @deprecated Spanish only. Use the catalog: "reportNote.<type>". */
    note: string;
    requires?: ModuleKey;
  }
> = {
  trips: { label: es.report.trips, note: es.reportNote.trips },
  stops: { label: es.report.stops, note: es.reportNote.stops },
  mileage: { label: es.report.mileage, note: es.reportNote.mileage },
  speed: { label: es.report.speed, note: es.reportNote.speed },
  geofences: { label: es.report.geofences, note: es.reportNote.geofences },
  alarms: { label: es.report.alarms, note: es.reportNote.alarms },
  utilization: { label: es.report.utilization, note: es.reportNote.utilization },
  drivers: { label: es.report.drivers, note: es.reportNote.drivers, requires: "B" },
  fuel: { label: es.report.fuel, note: es.reportNote.fuel, requires: "F" },
  maintenance: { label: es.report.maintenance, note: es.reportNote.maintenance, requires: "E" },
};

/**
 * What each value in a report is, so it is written the same on screen, in Excel
 * and in PDF. Dates are in ISO, durations in seconds, distances
 * in meters, speeds in km/h and percentages from 0 to 100.
 */
export type ReportCell = "text" | "datetime" | "date" | "duration" | "distance" | "speed" | "integer" | "decimal" | "liters" | "percent" | "place";
export interface ReportPlace {
  lat: number;
  lon: number;
  /** Approximate address, if already known. */
  address: string | null;
}
export type ReportValue = string | number | null | ReportPlace;
export interface ReportColumn {
  label: string;
  type: ReportCell;
}
export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: ReportValue[][];
  /** Totals row, with one value per column; null if the table has none. */
  totals: ReportValue[] | null;
  /** Total rows that exist; if more than the ones that came, the table arrived truncated. */
  total: number;
}
export interface ReportStat {
  label: string;
  type: ReportCell;
  value: ReportValue;
}
export interface ReportChart {
  title: string;
  /** Unit of the values. */
  unit: ReportCell;
  /** One label per bar: days ("2026-11-21") or names. */
  labels: string[];
  labelType: "date" | "text";
  /** With more than one series, the bars are stacked. */
  series: { name: string; values: number[] }[];
}
export interface ReportDocument {
  type: ReportType;
  title: string;
  from: string;
  to: string;
  zone: string;
  generatedAt: string;
  /** Which vehicles it refers to: "Todos los vehículos", "Grupo Reparto"… */
  scope: string;
  /** Options it was generated with: "Límite: 100 km/h". */
  options: string[];
  stats: ReportStat[];
  chart: ReportChart | null;
  tables: ReportTable[];
  notes: string[];
}
/** Maximum rows in each table of a report. */
export const REPORT_MAX_ROWS = 5000;
export const REPORT_FORMATS = ["xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** Which vehicles and with what options a report is generated. */
export interface ReportParams {
  /** Only one group; null = all the person can see. */
  groupId: string | null;
  /** Only these vehicles; null = all. */
  vehicleIds: string[] | null;
  /** Speed report: the speed above which it counts as excess. */
  speedLimitKmh: number;
  /** Stops report: stops shorter than this are not listed. */
  minStopMin: number;
}
export const REPORT_PARAMS_DEFAULT: ReportParams = { groupId: null, vehicleIds: null, speedLimitKmh: 100, minStopMin: 5 };

export const REPORT_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];
/** Scheduled reports an account can have, and people who receive each one. */
export const SCHEDULES_MAX = 20;
export const SCHEDULE_RECIPIENTS_MAX = 10;

export interface ReportSchedule {
  id: string;
  name: string;
  type: ReportType;
  params: ReportParams;
  frequency: ReportFrequency;
  /** Time of delivery, in minutes since midnight in `zone`. */
  atMinute: number;
  /** Day of the week (0 = Sunday) for weekly ones, and day of the month (1 to 28) for monthly ones. */
  weekday: number;
  monthDay: number;
  zone: string;
  format: ReportFormat;
  /** People in the account who receive it. */
  recipients: { userId: string; name: string; email: string }[];
  active: boolean;
  nextRunAt: string | null;
  lastRun: { at: string; ok: boolean; error: string | null } | null;
  createdByName: string;
}

export const ALL_DASHBOARD_WIDGETS = ["totals", "fleet", "distance_by_day", "usage_by_day", "top_distance", "least_used", "alerts_by_type", "alerts_by_day", "driver_scores"] as const;
export type DashboardWidget = (typeof ALL_DASHBOARD_WIDGETS)[number];
export const DASHBOARD_WIDGETS: Record<
  DashboardWidget,
  {
    /** @deprecated Spanish only. Use the catalog: "dashboardWidget.<widget>". */
    label: string;
    /** @deprecated Spanish only. Use the catalog: "dashboardWidgetNote.<widget>". */
    note: string;
    requires?: ModuleKey;
  }
> = {
  totals: { label: es.dashboardWidget.totals, note: es.dashboardWidgetNote.totals },
  fleet: { label: es.dashboardWidget.fleet, note: es.dashboardWidgetNote.fleet },
  distance_by_day: { label: es.dashboardWidget.distance_by_day, note: es.dashboardWidgetNote.distance_by_day },
  usage_by_day: { label: es.dashboardWidget.usage_by_day, note: es.dashboardWidgetNote.usage_by_day },
  top_distance: { label: es.dashboardWidget.top_distance, note: es.dashboardWidgetNote.top_distance },
  least_used: { label: es.dashboardWidget.least_used, note: es.dashboardWidgetNote.least_used },
  alerts_by_type: { label: es.dashboardWidget.alerts_by_type, note: es.dashboardWidgetNote.alerts_by_type },
  alerts_by_day: { label: es.dashboardWidget.alerts_by_day, note: es.dashboardWidgetNote.alerts_by_day },
  driver_scores: { label: es.dashboardWidget.driver_scores, note: es.dashboardWidgetNote.driver_scores, requires: "B" },
};
export const DASHBOARD_PERIODS = ["today", "7d", "30d", "month"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
/** Dashboards each person can have in an account. */
export const DASHBOARDS_MAX = 10;
export const DASHBOARD_DEFAULT_WIDGETS: DashboardWidget[] = ["totals", "fleet", "distance_by_day", "usage_by_day", "top_distance", "alerts_by_type"];

export interface Dashboard {
  id: string;
  name: string;
  period: DashboardPeriod;
  groupId: string | null;
  /** Vehicles it shows, chosen one by one; null = it goes by the group. */
  vehicleIds: string[] | null;
  /** Indicators it shows, in order. */
  widgets: DashboardWidget[];
}
export interface DashboardTotals {
  distanceM: number;
  trips: number;
  /** Time on trips, with their short pauses. */
  drivingS: number;
  idleS: number;
  alerts: number;
  /** Vehicles that made at least one trip. */
  activeVehicles: number;
}
export interface DashboardData {
  from: string;
  to: string;
  vehicles: number;
  totals: DashboardTotals;
  /** The same over the previous period of equal length. */
  previous: DashboardTotals;
  days: { date: string; distanceM: number; trips: number; movingS: number; idleS: number; alerts: number }[];
  byVehicle: { id: string; name: string; distanceM: number; drivingS: number; idleS: number; trips: number }[];
  alertTypes: { type: EventType; count: number }[];
  /** Driver ranking, if the account has that module. */
  drivers: DriverRank[] | null;
}
