// Texts of the backend in English: mail.
import type { SameShape } from "@opengps/shared";
import type es from "../es/mail";

const en: SameShape<typeof es> = {
  action: {
    map: "View on the map",
    platform: "Open the platform",
    console: "Open the console",
  },
  layout: {
    buttonFallback: "If the button doesn't work, copy this address into your browser:",
  },

  resetPassword: {
    subject: "Reset your {{app}} password",
    heading: "Reset your password",
    body: "We received a request to change your password. The link expires in 1 hour. If it wasn't you, ignore this message.",
    action: "Create a new password",
  },
  passwordChanged: {
    subject: "Your {{app}} password changed",
    heading: "Your password changed",
    body: "The password of your {{app}} account was changed on {{when}}. If it was you, there is nothing to do. If it was not you, choose another one now with “Forgot my password”: doing so signs out every session of your account.",
    action: "Choose another password",
  },
  existingAccount: {
    subject: "You already have an account on {{app}}",
    heading: "You already have an account",
    body: "Someone, maybe you, tried to create an account with this email, but there already is one. Sign in with your password or with the service you created it with. If you do not remember your password, you can ask for a new one on the sign-in page with “Forgot my password”. If it was not you, there is nothing to do.",
    action: "Sign in to my account",
  },
  verifyEmail: {
    subject: "Confirm your email on {{app}}",
    heading: "Confirm your email",
    body: "To activate your account and add your GPS device, confirm that this email is yours. The link expires in 24 hours.",
    action: "Confirm my email",
  },

  mailTest: {
    subject: "Test email from {{app}}",
    heading: "Email works",
    body: "This message was sent from {{app}} through the mail server {{host}}. If you're reading it, the settings are correct.",
  },
  channelTest: {
    title: "Test message from {{app}}",
    body: "If you're reading this, this notification channel works.",
    label: "Test message",
  },
  notificationTest: {
    title: "Test notification from {{app}}",
    body: "This message checks that the notification “{{name}}” arrives through this channel. Nothing happened to your vehicles.",
    label: "Test notification",
  },
  systemTest: {
    title: "test notification",
    body: "This message checks that the system notification “{{name}}” arrives through this channel. Nothing happened on the platform.",
  },

  event: {
    body: "{{what}}. It happened on {{at}} ({{zone}} time). {{sender}}.",
    sentByNotification: "Sent to you by the notification “{{name}}”",
  },
  facts: {
    speeding: "was going {{speed}} km/h with a limit of {{limit}} km/h",
    stayShort: "stayed {{stayed}}; the minimum is {{minimum}}",
    stayLong: "has been there {{stayed}}; the maximum is {{maximum}}",
    signalLost: "has not reported for {{silent}}",
    routeDeviation: "strayed {{meters}} m from its route",
    unauthorizedMovement: "moved {{meters}} m away from where it was parked",
    tow: "is moving at {{speed}} km/h with the engine off",
    fuelTheft: "{{liters}} L left the tank with the engine off",
    fuelDrain: "{{liters}} L left the tank while stopped",
    fuelRefuel: "{{liters}} L went into the tank",
    noDescription: "no description",
    engineOverrev: "reached {{rpm}} rpm; the limit is {{limit}} rpm",
    engineOverheat: "reached {{temp}} °C; the limit is {{limit}} °C",
    batteryLow: "is at {{volts}} V; the minimum is {{limit}} V",
  },

  system: {
    accountCreated: {
      title: "a new account was created",
      body: "Someone signed up and created the account “{{name}}”.",
    },
    channelFailing: {
      title: "the {{channel}} channel is failing",
      body: "In the last hour {{n}} messages couldn't go out through {{channel}}. The last reason: {{reason}}. Check the channel's details.",
      noDetail: "no detail",
    },
  },

  channelProblem: {
    off: "That channel is turned off on the platform",
    incomplete: "The Twilio channel is missing its details",
    incompleteWebhook: "The Custom channel is missing the address it sends to",
  },
  channelProblemChooseOther: {
    off: "That channel is turned off on the platform. Choose another channel",
    incomplete: "The Twilio channel is missing its details. Choose another channel",
    incompleteWebhook: "The Custom channel is missing the address it sends to. Choose another channel",
  },
  channelProblemConnectFirst: {
    off: "That channel is turned off on the platform. Connect it first in Notification channels",
    incomplete: "The Twilio channel is missing its details. Connect it first in Notification channels",
    incompleteWebhook: "The Custom channel is missing the address it sends to. Connect it first in Notification channels",
  },
  cap: {
    emailHour: "The account reached its limit of emails per hour",
    monthly: "The account reached its monthly limit of messages through this channel",
  },
  delivery: {
    answered: "Answered {{code}}",
    failed: "Couldn't send",
    mailFailed: "Couldn't send the email",
    pushNotYet: "Push notifications will come with the mobile app",
    unreadableTarget: "That destination can no longer be read: write it again",
  },
};
export default en;
