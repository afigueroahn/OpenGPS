// Texts of the backend in English: routes.
import type { SameShape } from "@opengps/shared";
import type es from "../es/routes";

const en: SameShape<typeof es> = {
  errors: {
    fromNeeded: "The start date is missing",
    toNeeded: "The end date is missing",
    placeNotFound: "This place doesn't exist",
    routeNotFound: "This route doesn't exist",
    lineTooShort: "The path needs at least two points",
    noHistory: "The vehicle has no recorded path in that period",
    tripNotFound: "This dispatch doesn't exist",
    stopNeeded: "The dispatch needs at least one stop",
    tripClosed: "This dispatch is already closed",
    tripCancelled: "This dispatch is cancelled",
    stopNotFound: "This stop doesn't exist",
    linkGone: "This link is no longer available",
    proofType: "The proof of delivery must be an image (JPG, PNG or WebP)",
    imageEmpty: "The image is empty",
    imageTooBig: "The image is over {{mb}} MB",
    proofNotFound: "This stop doesn't have that proof of delivery",
  },
  nearest: {
    onTrip: "On the route “{{name}}”",
    notReporting: "Not reporting",
  },
};
export default en;
