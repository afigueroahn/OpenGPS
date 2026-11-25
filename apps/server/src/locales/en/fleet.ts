// Texts of the backend in English: fleet.
import type { SameShape } from "@opengps/shared";
import type es from "../es/fleet";

const en: SameShape<typeof es> = {
  errors: {
    fromNeeded: "The start date is missing",
    toNeeded: "The end date is missing",
    fileType: "Only photos (JPG, PNG, WebP) and PDF documents are accepted",
    photoNotImage: "The vehicle photo must be an image",
    fileTooBig: "The file is larger than {{mb}} MB",
    tooManyFiles: "A vehicle accepts up to {{max}} files. Delete one you no longer need.",
    documentNotFound: "That document does not exist",
    documentGone: "The file of that document is no longer on the server",
    expenseNotFound: "That expense does not exist",
    assignedInDrivers: "This account tracks drivers in their own module: change the assignment from the vehicle's page, under Driver",
    alreadyAssigned: "On those dates the vehicle is already assigned to someone else",
    assignmentNotFound: "That assignment does not exist",
    groupNotFound: "That group does not exist",
    parentNotFound: "The group you want to place it under does not exist",
    groupLoop: "A group cannot be placed under itself or under one of its subgroups",
  },
  expenses: {
    fill: "Fill-up of {{liters}} L",
    fillAt: "Fill-up of {{liters}} L at {{station}}",
    workOrder: "Work order #{{number}}: {{title}}",
  },
  assignments: {
    byKey: "Identified with their key",
  },
  documents: { unnamed: "file" },
};
export default en;
