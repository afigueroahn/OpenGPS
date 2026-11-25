// Texts of the backend in English: maintenance.
import type { SameShape } from "@opengps/shared";
import type es from "../es/maintenance";

const en: SameShape<typeof es> = {
  errors: {
    planNotFound: "This plan doesn't exist",
    vehicleNotFound: "One of the vehicles doesn't exist",
    scheduleNotFound: "This scheduled service doesn't exist",
    expiryNotFound: "This expiry doesn't exist",
    orderNotFound: "This work order doesn't exist",
    scheduleOtherVehicle: "This scheduled service belongs to another vehicle",
    workshopNotFound: "This workshop doesn't exist",
    workshopExists: "You already have a workshop or supplier with that name",
    partNotFound: "This part doesn't exist",
    partExists: "You already have a part with that name",
    partGone: "One of the parts is no longer in the catalog",
    fileType: "Only photos (JPG, PNG, WebP) and PDF documents are allowed",
    fileTooBig: "The file is over {{mb}} MB",
    tooManyFiles: "A work order can have up to {{max}} files. Delete one you no longer need.",
    fileNotFound: "This file doesn't exist",
    fileMissing: "This file is no longer on the server",
  },
  files: {
    defaultName: "file",
  },
  notices: {
    expired: "expired on {{date}}",
    dueToday: "expires today",
    expires: "expires on {{date}}",
  },
};
export default en;
