// Texts of the backend in English: fuel.
import type { SameShape } from "@opengps/shared";
import type es from "../es/fuel";

const en: SameShape<typeof es> = {
  errors: {
    fromNeeded: "The start date is missing",
    toNeeded: "The end date is missing",
    calibrationOverCapacity: "The calibration table goes beyond the tank capacity",
    notConfigured: "That vehicle does not have fuel set up",
    tooManyPositions: "That period has too many positions. Choose a shorter range.",
    fillRepeated: "That fill-up is already recorded: same vehicle, same time and same liters",
    fillClash: "Another fill-up is already recorded with that time and those liters",
    fillNotFound: "That fill-up does not exist",
  },
  import: {
    noRows: "The file has no rows: the first one holds the headers and the following ones, the fill-ups",
    tooManyRows: "The file has more than {{max}} rows. Split it into parts.",
    missingColumns: "The file is missing the column {{columns}}. The headers go in the first row.",
    column: {
      vehicle: "Vehicle (or Plate)",
      date: "Date",
      liters: "Liters",
    },
    unknownVehicle: "There is no vehicle named “{{name}}” or with that plate",
    vehicleMissing: "The vehicle is missing",
    ambiguousVehicle: "More than one vehicle is named “{{name}}” or has that plate",
    badDate: "The date “{{value}}” cannot be understood. Use 2026-11-22 14:30 or 22/11/2026 14:30",
    badLiters: "The liters “{{value}}” are not a valid number",
    badTotal: "The total “{{value}}” is not a valid number",
    badCurrency: "The currency “{{value}}” is not a three-letter code",
  },
};
export default en;
