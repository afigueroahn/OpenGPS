// Texts of the backend in English: api.
import type { SameShape } from "@opengps/shared";
import type es from "../es/api";

const en: SameShape<typeof es> = {
  errors: {
    signIn: "Sign in to continue",
    forbidden: "You don't have permission to do this",
    notFound: "Not found",
    internal: "Something went wrong on our side. Please try again.",
    badRequest: "The request is not valid",
    invalidData: "Invalid data",
    origin: "Origin not allowed",
    accountSuspended: "This account is suspended. Write to us to review it.",
    registrationClosed: "Sign-up for new accounts is closed. You need an invitation to get in.",
    notYourAccount: "You don't belong to that account",
    tooManyLookups: "Too many requests. Wait a moment.",
    shareGone: "This link is no longer available",
  },
  validation: {
    fromNeeded: "The start date is missing",
    toNeeded: "The end date is missing",
    formatUnavailable: "Format not available",
    legalVersion: "That version of the terms is no longer in force",
    testTarget: "Write where to send the test",
    deleteWord: "Type DELETE to confirm",
  },
  account: {
    renameOwnerOnly: "Only the owner or an administrator of the account changes its name",
  },
  auth: {
    defaultAccountName: "My account",
    legalNotAccepted: "You must accept the terms of use and the privacy policy",
    ownerStays: "You own the platform: your account cannot be deleted",
  },
  invitation: {
    otherEmail: "This invitation is for another email. Sign in with the account that received it.",
    alreadyMember: "You are already part of that account",
    invalid: "This invitation is no longer valid",
    failed: "The invitation couldn't be accepted. It may have expired.",
  },
  notifications: {
    notFound: "That notification doesn't exist",
    vehiclesGone: "One of the vehicles no longer exists or you can't see it",
    onlyYourVehicles: "You can only create notifications for the vehicles you see",
    groupsGone: "One of the groups no longer exists",
    rolesGone: "One of the roles no longer exists",
    peopleGone: "One of the people is no longer part of the account",
    alertsGone: "One of the alerts no longer exists",
    addressesWholeAccount: "Only someone who sees the whole account can notify addresses typed by hand",
    https: "The address must start with https://",
    max: "An account can have up to {{max}} notifications",
    systemMax: "There can be up to {{max}} system notifications",
    noTargets: "This notification has no one to send to",
    noPushYet: "No one in this notification has the mobile app yet: push notifications will reach them once they install it",
    noTargetsOnChannel: "None of the people in this notification can receive it through this channel",
  },
  platform: {
    noMailServer: "No mail server is configured",
    mailRefused: "The mail server didn't accept the message: {{reason}}",
    storageNeeded: "First enter the storage details, with its secret key",
    pushNotYet: "Push notifications will come with the mobile app: there is nowhere to receive them yet",
    testNotSent: "The test message didn't go out",
    backupsUnavailable: "This server isn't set up to make backups",
  },
  traccar: {
    unreachable: "The GPS server is not answering. Try again in a few minutes.",
    offline: "The device is not connected right now",
  },
};
export default en;
