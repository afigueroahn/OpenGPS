// The emails the console can rewrite: how the platform writes them, how a
// rewritten one goes out, and what the console refuses.
import { LANGUAGES, MAIL_TEMPLATES, type MailTemplateInfo, type MailTemplates, type PlatformSettings, mailTemplateHasAction, mailTemplateProblem } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMailText, writeMail } from "../src/core/mail-templates";
import { type Harness, type TestUser, createHarness } from "./harness";

describe("writing an email", () => {
  it("every email comes in every language, with words in every field and only its own variables", () => {
    for (const id of MAIL_TEMPLATES) {
      for (const language of LANGUAGES) {
        const text = defaultMailText(id, language);
        expect(mailTemplateProblem(id, text), `${id} ${language}`).toBeNull();
        expect(text.action !== "", `${id} ${language}`).toBe(mailTemplateHasAction(id));
      }
    }
  });

  it("goes out as the platform writes it, with its variables filled and its button", () => {
    const mail = writeMail({}, "verifyEmail", "es", { app: "OpenGPS" }, "https://ejemplo.com/confirmar");
    expect(mail).toEqual({
      subject: "Confirma tu correo en OpenGPS",
      heading: "Confirma tu correo",
      body: expect.stringContaining("El enlace vence en 24 horas"),
      action: { label: "Confirmar mi correo", url: "https://ejemplo.com/confirmar" },
      language: "es",
    });
    expect(writeMail({}, "verifyEmail", "en", { app: "OpenGPS" }).subject).toBe("Confirm your email on OpenGPS");
  });

  it("a rewritten email goes out rewritten in its language; the other language stays as it came", () => {
    const templates: MailTemplates = { invitation: { es: { subject: "{{inviter}} te espera en {{account}}", heading: "Hola", body: "Únete a {{app}}.\nVence en {{days}} días.", action: "Entrar" } } };
    const words = { app: "OpenGPS", inviter: "Ana", account: "Transportes", role: "Operador", days: 7 };
    const es = writeMail(templates, "invitation", "es", words, "https://ejemplo.com/invitation?id=1");
    expect(es).toMatchObject({ subject: "Ana te espera en Transportes", heading: "Hola", body: "Únete a OpenGPS.\nVence en 7 días.", action: { label: "Entrar" } });
    expect(writeMail(templates, "invitation", "en", words).subject).toBe("Ana invited you to Transportes on OpenGPS");
  });

  it("the test email has no button", () => {
    expect(writeMail({}, "mailTest", "es", { app: "OpenGPS", host: "smtp.ejemplo.com" }, "https://ejemplo.com")).not.toHaveProperty("action");
  });

  it("the scheduled report says what it carries and why it arrives", () => {
    const words = { app: "OpenGPS", schedule: "Kilometraje diario", headline: "3 vehículos recorrieron 120 km", title: "reporte de kilometraje", summary: "3 vehículos recorrieron 120 km.", every: "cada día", who: "Ana" };
    expect(writeMail({}, "scheduledReport", "es", words, "https://ejemplo.com/reports")).toMatchObject({
      subject: "Kilometraje diario · 3 vehículos recorrieron 120 km",
      heading: "Kilometraje diario",
      body: "Va adjunto el reporte de kilometraje. 3 vehículos recorrieron 120 km. Este informe llega cada día porque Ana lo programó en OpenGPS.",
    });
  });

  it("refuses a variable the email does not have, and an empty field", () => {
    const text = { ...defaultMailText("resetPassword", "es"), subject: "Tu clave en {{ap}}" };
    expect(mailTemplateProblem("resetPassword", text)).toEqual({ key: "validation.mailTemplateVariable", params: { variable: "{{ap}}" } });
    expect(mailTemplateProblem("resetPassword", { ...text, subject: "  " })).toEqual({ key: "validation.mailTemplateField" });
    expect(mailTemplateProblem("resetPassword", { ...defaultMailText("resetPassword", "es"), action: "" })).toEqual({ key: "validation.mailTemplateField" });
    // Without a button, its text is not needed.
    expect(mailTemplateProblem("mailTest", { ...defaultMailText("mailTest", "es"), action: "" })).toBeNull();
  });
});

describe("the console", () => {
  let h: Harness;
  let boss: TestUser; // administers the platform
  let customer: TestUser; // any account
  const admin = (method: string, url: string, body?: unknown) => h.request(method, url, body === undefined ? { cookie: boss.cookie } : { cookie: boss.cookie, body });
  const save = (body: unknown) => admin("PUT", "/api/admin/settings/mailTemplates", body);

  beforeAll(async () => {
    h = await createHarness();
    boss = await h.signUp("Admin de correos");
    await h.makeOwner(boss);
    customer = await h.signUp("Cliente cualquiera");
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it("lists every email with its variables and its words in every language, only for whoever administers", async () => {
    const res = await admin("GET", "/api/admin/settings/mail/templates");
    expect(res.status).toBe(200);
    const templates = res.json.templates as MailTemplateInfo[];
    expect(templates.map((t) => t.id)).toEqual([...MAIL_TEMPLATES]);
    expect(templates.find((t) => t.id === "invitation")).toMatchObject({ variables: ["app", "inviter", "account", "role", "days"], action: true });
    expect(templates.find((t) => t.id === "resetPassword")?.defaults.es.subject).toBe("Restablece tu contraseña de {{app}}");
    expect(templates.find((t) => t.id === "resetPassword")?.defaults.en.subject).toBe("Reset your {{app}} password");
    expect((await h.request("GET", "/api/admin/settings/mail/templates", { cookie: customer.cookie })).status).toBe(404);
    expect((await h.request("PUT", "/api/admin/settings/mailTemplates", { cookie: customer.cookie, body: {} })).status).toBe(404);
  });

  it("refuses a variable the email does not have, or an email that does not exist", async () => {
    const bad = await save({ resetPassword: { es: { subject: "Clave de {{plataforma}}", heading: "Hola", body: "Texto", action: "Cambiar" } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("{{plataforma}}");
    expect((await save({ inventado: { es: { subject: "a", heading: "b", body: "c", action: "d" } } })).status).toBe(400);
    expect((await admin("GET", "/api/admin/settings")).json.settings.mailTemplates).toEqual({});
  });

  it("a rewritten email goes out rewritten from that moment, and resetting brings back the platform's words", async () => {
    const rewritten = { subject: "  Cambia tu clave de {{app}}  ", heading: "Tu clave", body: "Pediste una clave nueva.\r\nSi no fuiste tú, ignóralo.", action: "Elegir clave" };
    const saved = await save({ resetPassword: { es: rewritten } });
    expect(saved.status).toBe(200);
    expect((saved.json.settings as PlatformSettings).mailTemplates).toEqual({
      resetPassword: { es: { subject: "Cambia tu clave de {{app}}", heading: "Tu clave", body: "Pediste una clave nueva.\nSi no fuiste tú, ignóralo.", action: "Elegir clave" } },
    });

    const ask = () => h.request("POST", "/api/auth/request-password-reset", { body: { email: customer.email, redirectTo: "/reset-password" } });
    expect((await ask()).status).toBe(200);
    await h.settle();
    const mail = h.mails.findLast((m) => m.to === customer.email);
    expect(mail).toMatchObject({ subject: `Cambia tu clave de ${h.config.appName}`, body: "Pediste una clave nueva.\nSi no fuiste tú, ignóralo." });
    expect(mail?.url).toContain("/reset-password");

    expect((await admin("DELETE", "/api/admin/settings/mailTemplates")).json.settings.mailTemplates).toEqual({});
    expect((await ask()).status).toBe(200);
    await h.settle();
    expect(h.mails.findLast((m) => m.to === customer.email)?.subject).toBe(`Restablece tu contraseña de ${h.config.appName}`);
  });
});
