// Outgoing mail over SMTP.
import type { Language } from "@opengps/shared";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config";
import { tr } from "./i18n";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface Mailer {
  /** `language` is the one the message is written in: the frame around it follows it. */
  send(message: { to: string; subject: string; heading: string; body: string; action?: { label: string; url: string }; attachments?: MailAttachment[]; language: Language }): Promise<void>;
  verify(): Promise<void>;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function createMailer(config: Config): Mailer {
  const { appName } = config;
  // The mail server can be changed from the console: it is checked on every
  // send, and the connection is rebuilt only when its settings change.
  let built: { key: string; transport: Transporter } | null = null;
  const transportOf = (): Transporter | null => {
    const smtp = config.smtp;
    if (!smtp.host) return null;
    const key = JSON.stringify([smtp.host, smtp.port, smtp.security, smtp.user, smtp.password]);
    if (built?.key !== key) {
      built?.transport.close();
      built = {
        key,
        transport: nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.security === "ssl",
          requireTLS: smtp.security === "starttls",
          ignoreTLS: smtp.security === "none",
          ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
          connectionTimeout: 15_000,
          socketTimeout: 20_000,
        }),
      };
    }
    return built.transport;
  };

  return {
    async send(m) {
      const transport = transportOf();
      if (!transport) {
        // Without a mail server, the message is written to the log. Only useful for development.
        console.warn(`[mail] SMTP not configured. To ${m.to}: ${m.subject}${m.action ? ` → ${m.action.url}` : ""}${m.attachments?.length ? ` (attached: ${m.attachments.map((a) => a.filename).join(", ")})` : ""}`);
        return;
      }
      const text = [m.heading, "", m.body, ...(m.action ? ["", `${m.action.label}: ${m.action.url}`] : []), "", `— ${appName}`].join("\n");
      const html = `<!doctype html><html lang="${m.language}"><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td style="font-size:14px;font-weight:600;color:#0f5fd7;padding-bottom:16px">${escapeHtml(appName)}</td></tr>
<tr><td style="font-size:20px;font-weight:600;padding-bottom:12px">${escapeHtml(m.heading)}</td></tr>
<tr><td style="font-size:15px;line-height:1.5;padding-bottom:24px">${escapeHtml(m.body).replace(/\n/g, "<br>")}</td></tr>
${
  m.action
    ? `<tr><td style="padding-bottom:24px"><a href="${escapeHtml(m.action.url)}" style="display:inline-block;background:#0f5fd7;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px">${escapeHtml(m.action.label)}</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#667085;word-break:break-all">${escapeHtml(tr(m.language, "mail.layout.buttonFallback"))}<br>${escapeHtml(m.action.url)}</td></tr>`
    : ""
}
</table></td></tr></table></body></html>`;
      await transport.sendMail({ from: config.smtp.from, to: m.to, subject: m.subject, text, html, ...(m.attachments?.length ? { attachments: m.attachments } : {}) });
    },
    async verify() {
      await transportOf()?.verify();
    },
  };
}
