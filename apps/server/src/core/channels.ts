// The channels a message can leave the platform through. Each one knows how to
// hand a message to its service and how to read that service's answer; none
// decides who receives what: that is up to the notifications.
import { CUSTOM_VARIABLE_PATTERN, type CustomVariable, type Language, type NotifyChannel, usesPerson, variablesIn } from "@opengps/shared";
import type { Config } from "../config";
import { type Say, say } from "../i18n";
import type { Mailer } from "../mail";
import { type OutboundOptions, OutboundError, post } from "./outbound";

/** What is sent, the same for every channel; each one shapes it its own way. */
export interface Message {
  /** First line: what happened. */
  title: string;
  body: string;
  /** Where to look at it. */
  action: { label: string; url: string } | null;
  language: Language;
  /** The same thing as data, for a channel that talks to another system. */
  data: Record<string, unknown> | null;
}

export interface SendResult {
  /** What the service answered, if it got to answer. */
  code: number | null;
  /** Why it did not go out, or null if it did. A text of the catalogs is worded when the log keeps it. */
  error: Say | string | null;
}

export interface ChannelDeps {
  config: Pick<Config, "channels" | "providers" | "appName">;
  mailer: Mailer;
  /** How to call addresses written by the accounts. The services of the channels are always reachable. */
  outbound: OutboundOptions;
}

/** The services' addresses come from the server's configuration, not from an account: they are called as they are. */
const SERVICE: OutboundOptions = { allowInternal: true, timeoutMs: 15_000 };
const JSON_HEADERS = { "Content-Type": "application/json" };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The reason a service gave for refusing, taken from its answer. */
function reasonOf(body: string, pick: (json: Record<string, unknown>) => unknown, code: number): Say | string {
  try {
    const reason = pick(JSON.parse(body) as Record<string, unknown>);
    if (typeof reason === "string" && reason.trim()) return clip(oneLine(reason), 200);
  } catch {
    // Not JSON: the code says enough.
  }
  return say("mail.delivery.answered", { code });
}

/**
 * Why a channel cannot send right now, or null if it can. With `then`, followed
 * by what to do about it: choose another channel (an account saving something
 * that sends through it) or connect it first (the console saving a notification).
 */
export function channelProblem(config: Pick<Config, "channels">, channel: NotifyChannel, then?: "chooseOther" | "connectFirst"): Say | null {
  const c = config.channels;
  const kind = !c[channel].enabled
    ? "off"
    : channel === "sms" && (!c.sms.accountSid || !c.sms.token || !c.sms.from)
      ? "incomplete"
      : channel === "webhook" && !c.webhook.url
        ? "incompleteWebhook"
        : null;
  if (kind === null) return null;
  if (then === "chooseOther") return say(`mail.channelProblemChooseOther.${kind}`);
  if (then === "connectFirst") return say(`mail.channelProblemConnectFirst.${kind}`);
  return say(`mail.channelProblem.${kind}`);
}

async function call(
  target: string,
  body: string,
  headers: Record<string, string>,
  opts: OutboundOptions,
  ok: (code: number, body: string) => Say | string | null,
  method: "POST" | "GET" | "PUT" = "POST",
): Promise<SendResult> {
  try {
    const response = await post(target, body, headers, opts, method);
    return { code: response.code, error: ok(response.code, response.body) };
  } catch (err) {
    return { code: null, error: err instanceof OutboundError ? err.message : say("mail.delivery.failed") };
  }
}

/** Who a message of the custom channel goes to, to fill its variables. Without anyone, they stay empty. */
export interface Recipient {
  name?: string;
  email?: string;
  phone?: string;
  language?: Language;
}
/** How a recipient travels as the destination of a message of the custom channel. */
export const recipientTarget = (r: Recipient): string => JSON.stringify(r);
/** A destination written by hand (an email, a phone or nothing), as a recipient of the custom channel. */
export const writtenRecipient = (address: string): Recipient => (address.includes("@") ? { email: address } : address ? { phone: address } : {});

function recipientOf(target: string): Recipient {
  try {
    const r: unknown = JSON.parse(target);
    return r && typeof r === "object" ? (r as Recipient) : {};
  } catch {
    return {};
  }
}

/** The values the variables of the custom channel take for a message and whoever receives it. */
export function variablesOf(appName: string, message: Message, to: Recipient): Record<CustomVariable, string> {
  const data = (message.data ?? {}) as { type?: unknown; label?: unknown; createdAt?: unknown; event?: unknown };
  const event = (data.event && typeof data.event === "object" ? data.event : {}) as Record<string, unknown>;
  const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  return {
    type: text(data.type),
    event: text(data.label),
    title: message.title,
    body: message.body,
    message: oneLine(`${message.title}. ${message.body}`),
    vehicle: text(event.vehicleName),
    time: text(event.at ?? data.createdAt),
    latitude: text(event.lat),
    longitude: text(event.lon),
    speed: text(event.speedKmh),
    link: message.action?.url ?? "",
    app: appName,
    name: to.name ?? "",
    email: to.email ?? "",
    phone: to.phone ?? "",
    phone_digits: (to.phone ?? "").replace(/\D/g, ""),
    language: to.language ?? message.language,
  };
}

/**
 * Whom the custom channel speaks of, by what its owner wrote: each person (with their phone, if only the phone is
 * used) or nobody, and then one message is enough for everyone. `label` names it in the log when it is nobody.
 */
export function customAudience(c: Config["channels"]["webhook"]): { perPerson: boolean; needsPhone: boolean; label: string } {
  const texts = [c.url, c.body, ...c.headers.map((h) => h.value)];
  const used = new Set(texts.flatMap(variablesIn));
  return {
    perPerson: usesPerson(texts),
    needsPhone: (used.has("phone") || used.has("phone_digits")) && !used.has("email"),
    label: /^https?:\/\/([^/?#]+)/i.exec(c.url)?.[1]?.toLowerCase() ?? "—",
  };
}

/** A text of the custom channel with its variables replaced, each value written the way that place needs. */
const fill = (text: string, values: Record<string, string>, write: (value: string) => string) => text.replace(CUSTOM_VARIABLE_PATTERN, (_, name: string) => write(values[name] ?? ""));

/** What a message carries when its owner did not write a body: every variable, as JSON. */
function defaultBody(values: Record<CustomVariable, string>): string {
  const number = (value: string) => (value === "" ? null : Number(value));
  return JSON.stringify({
    ...values,
    latitude: number(values.latitude),
    longitude: number(values.longitude),
    speed: number(values.speed),
  });
}

/** How the custom channel calls the other system for a message and whoever receives it. */
export function customRequest(appName: string, c: Config["channels"]["webhook"], message: Message, to: Recipient) {
  const values = variablesOf(appName, message, to);
  const headers = Object.fromEntries(c.headers.map((h) => [h.name, fill(h.value, values, (value) => value.replace(/[\r\n]+/g, " "))]));
  const type = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
  // Inside JSON a value is escaped as a string; in a form, encoded as in an address; anything else, as it is.
  const write = !type || /json/i.test(type) ? (value: string) => JSON.stringify(value).slice(1, -1) : /x-www-form-urlencoded/i.test(type) ? encodeURIComponent : (value: string) => value;
  const body = c.method === "GET" ? "" : c.body.trim() ? fill(c.body, values, write) : defaultBody(values);
  return {
    method: c.method,
    url: fill(c.url, values, encodeURIComponent),
    headers: { ...(c.method === "GET" || type ? {} : JSON_HEADERS), ...headers, "User-Agent": "OpenGPS-Notifications/1" },
    body,
  };
}

const SENDERS: Record<NotifyChannel, (deps: ChannelDeps, target: string, message: Message) => Promise<SendResult>> = {
  async email(deps, target, message) {
    try {
      await deps.mailer.send({ to: target, subject: message.title, heading: message.title, body: message.body, ...(message.action ? { action: message.action } : {}), language: message.language });
      return { code: null, error: null };
    } catch (err) {
      const reason = (err as Error).message;
      return { code: null, error: reason ? clip(oneLine(reason), 200) : say("mail.delivery.mailFailed") };
    }
  },

  // Twilio's SMS API.
  sms(deps, target, message) {
    const c = deps.config.channels.sms;
    const text = clip(oneLine(`${deps.config.appName}: ${message.title}. ${message.body}`), 320);
    // What starts with MG is a messaging service, not a number.
    const from = c.from.startsWith("MG") ? { MessagingServiceSid: c.from } : { From: c.from };
    const body = new URLSearchParams({ To: target, Body: text, ...from }).toString();
    const auth = Buffer.from(`${c.accountSid}:${c.token}`).toString("base64");
    return call(`${deps.config.providers.twilio}/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, body, { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${auth}` }, SERVICE, (code, answer) =>
      code >= 200 && code < 300 ? null : reasonOf(answer, (json) => json.message, code),
    );
  },

  // Another system, called the way the owner wrote it, with the variables of the message and of whoever receives it.
  webhook(deps, target, message) {
    const r = customRequest(deps.config.appName, deps.config.channels.webhook, message, recipientOf(target));
    return call(r.url, r.body, r.headers, deps.outbound, (code) => (code >= 200 && code < 300 ? null : say("mail.delivery.answered", { code })), r.method);
  },

  // The mobile app. It does not exist yet, so nobody has where to receive these: no message gets this far.
  async push() {
    return { code: null, error: say("mail.delivery.pushNotYet") };
  },
};

/** Hands a message to a channel. It never throws: what went wrong comes back as text to say. */
export async function sendThrough(deps: ChannelDeps, channel: NotifyChannel, target: string, message: Message): Promise<SendResult> {
  const problem = channelProblem(deps.config, channel);
  if (problem) return { code: null, error: problem };
  return SENDERS[channel](deps, target, message);
}
