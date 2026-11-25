// The emails the platform writes with words of its own. Each one is in the
// catalogs, in every language; the console can rewrite them (settings section
// "mailTemplates"), and what it rewrote goes out instead. Its variables are
// filled in when it is sent.
import {
  LANGUAGES,
  type Language,
  MAIL_TEMPLATES,
  MAIL_TEMPLATE_VARIABLES,
  type MailTemplateId,
  type MailTemplateInfo,
  type MailTemplateText,
  type MailTemplates,
  type TextParams,
  fillText,
  mailTemplateHasAction,
} from "@opengps/shared";
import { type ServerKey, tr } from "../i18n";

/** Where each email's words are in the catalogs. */
const SOURCES: Record<MailTemplateId, { subject: ServerKey; heading: ServerKey; body: ServerKey; action?: ServerKey }> = {
  verifyEmail: { subject: "mail.verifyEmail.subject", heading: "mail.verifyEmail.heading", body: "mail.verifyEmail.body", action: "mail.verifyEmail.action" },
  resetPassword: { subject: "mail.resetPassword.subject", heading: "mail.resetPassword.heading", body: "mail.resetPassword.body", action: "mail.resetPassword.action" },
  existingAccount: { subject: "mail.existingAccount.subject", heading: "mail.existingAccount.heading", body: "mail.existingAccount.body", action: "mail.existingAccount.action" },
  invitation: {
    subject: "core.members.invitationMail.subject",
    heading: "core.members.invitationMail.heading",
    body: "core.members.invitationMail.body",
    action: "core.members.invitationMail.action",
  },
  // The panic emails say in their heading the same as in their subject.
  panic: { subject: "antitheft.mail.sosSubject", heading: "antitheft.mail.sosSubject", body: "antitheft.mail.sosBody", action: "antitheft.mail.openPlatform" },
  panicUnattended: { subject: "antitheft.mail.unattendedSubject", heading: "antitheft.mail.unattendedSubject", body: "antitheft.mail.unattendedBody", action: "antitheft.mail.openPlatform" },
  scheduledReport: { subject: "reports.mail.subject", heading: "reports.mail.heading", body: "reports.mail.body", action: "reports.mail.action" },
  mailTest: { subject: "mail.mailTest.subject", heading: "mail.mailTest.heading", body: "mail.mailTest.body" },
};

/** How the platform writes an email in a language, with its variables still to fill. */
export function defaultMailText(id: MailTemplateId, language: Language): MailTemplateText {
  const source = SOURCES[id];
  return {
    subject: tr(language, source.subject),
    heading: tr(language, source.heading),
    body: tr(language, source.body),
    action: source.action ? tr(language, source.action) : "",
  };
}

/** Every email, as the console shows it to rewrite it. */
export const mailTemplateInfo = (): MailTemplateInfo[] =>
  MAIL_TEMPLATES.map((id) => ({
    id,
    variables: MAIL_TEMPLATE_VARIABLES[id],
    action: mailTemplateHasAction(id),
    defaults: Object.fromEntries(LANGUAGES.map((language) => [language, defaultMailText(id, language)])) as Record<Language, MailTemplateText>,
  }));

/**
 * An email ready to send, in a language: its words as the console rewrote them or as the platform writes them,
 * with its variables filled. `url` is where its button goes; an email without a button has none.
 */
export function writeMail(templates: MailTemplates, id: MailTemplateId, language: Language, params: TextParams, url?: string) {
  const words = templates[id]?.[language] ?? defaultMailText(id, language);
  const fill = (text: string) => fillText(text, params);
  return {
    subject: fill(words.subject),
    heading: fill(words.heading),
    body: fill(words.body),
    ...(url && mailTemplateHasAction(id) ? { action: { label: fill(words.action), url } } : {}),
    language,
  };
}
