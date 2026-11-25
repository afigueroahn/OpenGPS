// The services people can sign in and sign up with, besides their email and
// password. Whoever runs the platform connects each one here, once: one
// button per service opens what it needs, with the address the service has to
// send people back to.
import { OAUTH_PROVIDERS, type OAuthProvider, type OAuthSettings, type OAuthSettingsInput } from "@opengps/shared";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { BrandMark } from "../../components/BrandMark";
import { Button, CopyText, Modal, Notice, Spinner } from "../../components/ui";
import { inputClass } from "../reports/kit";
import { errorText } from "../widgets";
import { Row, Switch, useSaveSection, useSettings } from "./SettingsTabs";

const field = clsx(inputClass, "w-full");
const NAME: Record<Exclude<OAuthProvider, "custom">, string> = { google: "Google", github: "GitHub", facebook: "Facebook", apple: "Apple" };

/** What is saved when nothing of a service's secret is touched: everything as it is, without the secrets. */
function inputOf(o: OAuthSettings): OAuthSettingsInput {
  const plain = <P extends OAuthProvider>(p: P) => {
    const { hasSecret: _secret, ...rest } = o[p];
    return rest;
  };
  return { google: plain("google"), github: plain("github"), facebook: plain("facebook"), apple: plain("apple"), custom: plain("custom") };
}

export function SignInSection() {
  const { t } = useTranslation();
  const settings = useSettings();
  // The open service lives in the address, so a link to one opens it.
  const [search, setSearch] = useSearchParams();
  const open = OAUTH_PROVIDERS.find((p) => p === search.get("provider")) ?? null;
  const show = (provider: OAuthProvider | null) => setSearch(provider ? { provider } : {}, { replace: true });

  if (settings.isError) return <Notice tone="error">{errorText(settings.error)}</Notice>;
  if (!settings.data) {
    return (
      <div className="flex h-32 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  const oauth = settings.data.oauth;
  const nameOf = (p: OAuthProvider) => (p === "custom" ? oauth.custom.name || t("admin.signIn.custom.title") : NAME[p]);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {OAUTH_PROVIDERS.map((p) => {
          const on = oauth[p].enabled && oauth[p].hasSecret;
          return (
            <button
              key={p}
              type="button"
              onClick={() => show(p)}
              aria-label={t("admin.signIn.configure", { name: nameOf(p) })}
              className="group flex min-h-[132px] flex-col items-start gap-3 rounded-[14px] border border-line bg-surface p-5 text-left transition-colors hover:border-faint"
            >
              <span className="flex w-full items-start justify-between gap-3">
                <span className={clsx("flex h-12 w-12 items-center justify-center rounded-[12px] border border-line bg-canvas text-ink", !on && "opacity-60")}>
                  <BrandMark id={p} size={22} />
                </span>
                <ChevronRight size={18} className="mt-1 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
              <span className="block text-[16px] font-semibold tracking-tight text-ink">{nameOf(p)}</span>
              <span className={clsx("mt-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium", on ? "bg-moving/15 text-signal-ink" : "bg-ink/[0.07] text-ink-3")}>
                <span className={clsx("h-1.5 w-1.5 rounded-full", on ? "bg-moving" : "bg-faint")} aria-hidden="true" />
                {t(on ? "admin.signIn.on" : "admin.signIn.off")}
              </span>
            </button>
          );
        })}
      </div>
      <p className="max-w-[70ch] text-[13.5px] leading-relaxed text-muted">{t("admin.signIn.note")}</p>

      <Modal open={open !== null} onClose={() => show(null)} title={open ? nameOf(open) : ""} wide>
        {open && <ProviderPanel key={open} provider={open} current={oauth} />}
      </Modal>
    </div>
  );
}

/** One service: its switch, its details and the address it sends people back to. A secret that is not written stays as it is. */
function ProviderPanel({ provider, current }: { provider: OAuthProvider; current: OAuthSettings }) {
  const { t } = useTranslation();
  const save = useSaveSection("oauth");
  const c = current[provider];
  const start = () => ({
    enabled: c.enabled,
    clientId: c.clientId,
    secret: "",
    teamId: current.apple.teamId,
    keyId: current.apple.keyId,
    name: current.custom.name,
    issuer: current.custom.issuer,
    scopes: current.custom.scopes,
  });
  const [form, setForm] = useState(start);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the server returns what was saved
  useEffect(() => setForm(start()), [current]);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(start());
  const back = `${window.location.origin}/api/auth/callback/${provider}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const secret = form.secret.trim() ? { secret: form.secret.trim() } : {};
    const base = inputOf(current);
    const mine =
      provider === "apple"
        ? { enabled: form.enabled, clientId: form.clientId.trim(), teamId: form.teamId.trim(), keyId: form.keyId.trim(), ...secret }
        : provider === "custom"
          ? { enabled: form.enabled, name: form.name.trim(), issuer: form.issuer.trim(), clientId: form.clientId.trim(), scopes: form.scopes.trim(), ...secret }
          : { enabled: form.enabled, clientId: form.clientId.trim(), ...secret };
    save.mutate({ ...base, [provider]: mine });
  };
  const kept = c.hasSecret ? t("admin.signIn.secretKept") : t("admin.signIn.secretEmpty");

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] border border-line bg-canvas text-ink">
          <BrandMark id={provider} size={22} />
        </span>
        <p className="min-w-0 flex-1 pt-0.5 text-[14px] leading-relaxed text-muted">{t(`admin.signIn.${provider}.lead`)}</p>
      </div>
      <div className="rounded-[12px] bg-canvas p-3.5">
        <p className="text-[13px] font-medium text-ink-3">{t("admin.signIn.steps")}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">{t(`admin.signIn.${provider}.steps`)}</p>
        <p className="mb-1.5 mt-3 text-[13px] font-medium text-ink-3">{t("admin.signIn.back")}</p>
        <CopyText value={back} />
      </div>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Row title={t("admin.signIn.enable")} note={t("admin.signIn.enableNote")}>
          <Switch label={t("admin.signIn.enable")} checked={form.enabled} onChange={(on) => set("enabled", on)} />
        </Row>
        {provider === "custom" && (
          <>
            <Row title={t("admin.signIn.custom.name")} note={t("admin.signIn.custom.nameNote")} wide>
              <input className={field} maxLength={40} placeholder={t("admin.signIn.custom.namePlaceholder")} value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Row>
            <Row title={t("admin.signIn.custom.issuer")} note={t("admin.signIn.custom.issuerNote")} wide>
              <input className={clsx(field, "font-mono text-[13px]")} spellCheck={false} autoComplete="off" placeholder="https://login.empresa.com/realms/personal" value={form.issuer} onChange={(e) => set("issuer", e.target.value)} />
            </Row>
          </>
        )}
        <Row title={t(`admin.signIn.${provider}.clientId`)} note={t(`admin.signIn.${provider}.clientIdNote`)} wide>
          <input className={clsx(field, "font-mono text-[13px]")} spellCheck={false} autoComplete="off" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} />
        </Row>
        {provider === "apple" && (
          <>
            <Row title={t("admin.signIn.apple.teamId")} note={t("admin.signIn.apple.teamIdNote")} wide>
              <input className={clsx(field, "font-mono text-[13px]")} spellCheck={false} autoComplete="off" maxLength={20} value={form.teamId} onChange={(e) => set("teamId", e.target.value)} />
            </Row>
            <Row title={t("admin.signIn.apple.keyId")} note={t("admin.signIn.apple.keyIdNote")} wide>
              <input className={clsx(field, "font-mono text-[13px]")} spellCheck={false} autoComplete="off" maxLength={20} value={form.keyId} onChange={(e) => set("keyId", e.target.value)} />
            </Row>
          </>
        )}
        <Row title={t(`admin.signIn.${provider}.secret`)} note={t("admin.signIn.secretNote")} wide>
          {provider === "apple" ? (
            <textarea
              rows={4}
              spellCheck={false}
              autoComplete="off"
              placeholder={kept}
              value={form.secret}
              onChange={(e) => set("secret", e.target.value)}
              className={clsx(inputClass, "h-auto w-full py-2 font-mono text-[12.5px]")}
            />
          ) : (
            <input className={field} type="password" autoComplete="new-password" placeholder={kept} value={form.secret} onChange={(e) => set("secret", e.target.value)} />
          )}
        </Row>
        {provider === "custom" && (
          <Row title={t("admin.signIn.custom.scopes")} note={t("admin.signIn.custom.scopesNote")} wide>
            <input className={clsx(field, "font-mono text-[13px]")} spellCheck={false} autoComplete="off" value={form.scopes} onChange={(e) => set("scopes", e.target.value)} />
          </Row>
        )}
        {save.isError && <Notice tone="error">{errorText(save.error)}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={save.isPending} disabled={!dirty}>
            {t("admin.signIn.save")}
          </Button>
          {save.isSuccess && !dirty && <span className="text-[13px] text-signal-ink">{t("admin.signIn.saved")}</span>}
          {dirty && <span className="text-[13px] text-muted">{t("admin.signIn.unsaved")}</span>}
        </div>
      </form>
    </div>
  );
}
