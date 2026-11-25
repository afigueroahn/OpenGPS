// Texts of the backend in English: drivers.
import type { SameShape } from "@opengps/shared";
import type es from "../es/drivers";

const en: SameShape<typeof es> = {
  errors: {
    fromNeeded: "The start date is missing",
    toNeeded: "The end date is missing",
    notFound: "That driver does not exist",
    keyTaken: "That key already belongs to another driver",
    inactive: "That driver has been deactivated",
    restTooLong: "The rest must be shorter than the maximum continuous driving time",
    dailyBelowContinuous: "The daily maximum cannot be less than the continuous maximum",
  },
  ranking: {
    noDriver: "No driver assigned",
  },
};
export default en;
