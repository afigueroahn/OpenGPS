// Platform console: general settings, password policy, outgoing
// email and external storage. Each section is saved separately and
// takes effect from that moment, without restarting anything.
import {
  ALL_MODULES,
  type GeneralSettings,
  LANGUAGES,
  LANGUAGE_NAME,
  type Language,
  HISTORY_RETENTION_MIN_DAYS,
  MAIL_SECURITIES,
  type MailSecurity,
  type ModuleKey,
  PASSWORD_MIN,
  type PasswordPolicy,
  type PlatformSettings,
  STORAGE_FLAGS_MAX,
  STORAGE_PROVIDERS,
  UPLOAD_MAX_MB,
  passwordHint,
  storageFlagProblem,
  storageNeedsEndpoint,
} from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sayShared } from "../../lib/i18n";
import clsx from "clsx";
import { Plus, Trash } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Modal, Notice, Spinner } from "../../components/ui";
import { type SettingsInputs, getPlatformSettings, resetPlatformSettings, savePlatformSettings, sendTestMail, testPlatformStorage } from "../../lib/api";
import { Card, inputClass } from "../reports/kit";
import { ConfirmDialog, errorText } from "../widgets";

export const useSettings = () => useQuery({ queryKey: ["admin", "settings"], queryFn: getPlatformSettings });

/** Saves a section and leaves in the console what the server returns. */
export function useSaveSection<S extends keyof SettingsInputs>(section: S) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsInputs[S]) => savePlatformSettings(section, body),
    onSuccess: (saved) => {
      queryClient.setQueryData(["admin", "settings"], saved);
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
    },
  });
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-moving" : "bg-faint/60")}
    >
      <span className={clsx("absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left]", checked ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

/** A setting: on the left what it is and what it is for; on the right, its control. */
export function Row({ title, note, children, wide }: { title: string; note?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="grid gap-x-8 gap-y-2 border-b border-line py-4 first:pt-0 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {note && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{note}</p>}
      </div>
      <div className={clsx("flex min-w-0 items-start", wide ? "flex-col gap-2" : "sm:justify-end")}>{children}</div>
    </div>
  );
}

const field = clsx(inputClass, "w-full");
const numberField = clsx(inputClass, "num w-28");
const digits = (text: string) => text.replace(/\D/g, "");

export function SaveBar({ dirty, saving, error, saved, children }: { dirty: boolean; saving: boolean; error: unknown; saved: boolean; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {error ? <Notice tone="error">{errorText(error)}</Notice> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving} disabled={!dirty}>
          {t("common.save")}
        </Button>
        {children}
        {saved && !dirty && <span className="text-[13px] text-signal-ink">{t("admin.settings.saved")}</span>}
        {dirty && <span className="text-[13px] text-muted">{t("admin.settings.unsaved")}</span>}
      </div>
    </div>
  );
}

/** Returns a section to its factory values, after asking. `what` says what changes. */
export function ResetButton({ section, what }: { section: keyof SettingsInputs; what: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
        {t("admin.settings.reset.action")}
      </Button>
      <ConfirmDialog
        open={open}
        title={t("admin.settings.reset.title")}
        confirm={t("admin.settings.reset.action")}
        onClose={() => setOpen(false)}
        action={async () => {
          queryClient.setQueryData(["admin", "settings"], await resetPlatformSettings(section));
          void queryClient.invalidateQueries({ queryKey: ["config"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
        }}
      >
        {what}
      </ConfirmDialog>
    </>
  );
}

function Loading({ query }: { query: ReturnType<typeof useSettings> }) {
  if (query.isError) return <Notice tone="error">{errorText(query.error)}</Notice>;
  return (
    <div className="flex h-40 items-center justify-center text-muted">
      <Spinner size={22} />
    </div>
  );
}

// ─── General settings and passwords ─────────────────────────────────────────

/** Numbers are edited as text, so they can be left empty while typing. */
type GeneralForm = Omit<
  GeneralSettings,
  "newAccountMaxVehicles" | "newAccountMaxUsers" | "claimWindowMinutes" | "maxPendingDevices" | "geocoderIntervalMs" | "historyRetentionDays" | "traccarRetentionDays" | "diskAlertPercent" | "alertEmailsPerHour" | "maxUploadMb"
> & {
  newAccountMaxVehicles: string;
  newAccountMaxUsers: string;
  claimWindowMinutes: string;
  maxPendingDevices: string;
  geocoderIntervalMs: string;
  historyRetentionDays: string;
  traccarRetentionDays: string;
  diskAlertPercent: string;
  alertEmailsPerHour: string;
  maxUploadMb: string;
};
const toForm = (g: GeneralSettings): GeneralForm => ({
  ...g,
  newAccountMaxVehicles: g.newAccountMaxVehicles === null ? "" : String(g.newAccountMaxVehicles),
  newAccountMaxUsers: g.newAccountMaxUsers === null ? "" : String(g.newAccountMaxUsers),
  claimWindowMinutes: String(g.claimWindowMinutes),
  maxPendingDevices: String(g.maxPendingDevices),
  geocoderIntervalMs: String(g.geocoderIntervalMs),
  historyRetentionDays: g.historyRetentionDays === 0 ? "" : String(g.historyRetentionDays),
  traccarRetentionDays: String(g.traccarRetentionDays),
  diskAlertPercent: String(g.diskAlertPercent),
  alertEmailsPerHour: String(g.alertEmailsPerHour),
  maxUploadMb: String(g.maxUploadMb),
});
const fromForm = (f: GeneralForm): GeneralSettings => ({
  ...f,
  newAccountMaxVehicles: f.newAccountMaxVehicles === "" ? null : Number(f.newAccountMaxVehicles),
  newAccountMaxUsers: f.newAccountMaxUsers === "" ? null : Number(f.newAccountMaxUsers),
  claimWindowMinutes: Number(f.claimWindowMinutes),
  maxPendingDevices: Number(f.maxPendingDevices),
  geocoderIntervalMs: Number(f.geocoderIntervalMs),
  historyRetentionDays: f.historyRetentionDays === "" ? 0 : Number(f.historyRetentionDays),
  traccarRetentionDays: Number(f.traccarRetentionDays),
  diskAlertPercent: Number(f.diskAlertPercent),
  alertEmailsPerHour: Number(f.alertEmailsPerHour),
  maxUploadMb: Number(f.maxUploadMb),
  mapStyleUrl: f.mapStyleUrl.trim(),
  geocoderUrl: f.geocoderUrl.trim(),
  geocoderUserAgent: f.geocoderUserAgent.trim(),
  routingUrl: f.routingUrl.trim(),
  alertEmail: f.alertEmail.trim(),
  legalEntity: f.legalEntity.trim(),
  legalCountry: f.legalCountry.trim(),
  legalContactEmail: f.legalContactEmail.trim(),
  appName: f.appName.trim(),
});

export function GeneralTab() {
  const settings = useSettings();
  if (!settings.data) return <Loading query={settings} />;
  return (
    <div className="space-y-6">
      <GeneralForm current={settings.data.general} />
      <PasswordsForm current={settings.data.passwords} />
    </div>
  );
}

function GeneralForm({ current }: { current: GeneralSettings }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<GeneralForm>(() => toForm(current));
  const [confirm, setConfirm] = useState(false);
  const save = useSaveSection("general");
  useEffect(() => setForm(toForm(current)), [current]);
  const set = <K extends keyof GeneralForm>(key: K, value: GeneralForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(current));
  const next = fromForm(form);
  // Shortening the history deletes positions forever: ask first.
  const shortens = next.historyRetentionDays > 0 && (current.historyRetentionDays === 0 || next.historyRetentionDays < current.historyRetentionDays);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (shortens) setConfirm(true);
    else save.mutate(next);
  };
  const toggleModule = (key: ModuleKey) => set("newAccountModules", form.newAccountModules.includes(key) ? form.newAccountModules.filter((m) => m !== key) : ALL_MODULES.filter((m) => m === key || form.newAccountModules.includes(m)));

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Card title={t("admin.settings.general.platform")}>
        <Row title={t("admin.settings.general.appName")} note={t("admin.settings.general.appNameNote")}>
          <input className={field} aria-label={t("admin.settings.general.appName")} maxLength={60} value={form.appName} onChange={(e) => set("appName", e.target.value)} />
        </Row>
      </Card>
      <Card title={t("admin.settings.general.signup")}>
        <Row title={t("admin.settings.general.registrationOpen")} note={t("admin.settings.general.registrationOpenNote")}>
          <Switch label={t("admin.settings.general.registrationOpen")} checked={form.registrationOpen} onChange={(on) => set("registrationOpen", on)} />
        </Row>
        <Row title={t("admin.settings.general.quotas")} note={t("admin.settings.general.quotasNote")}>
          <div className="flex flex-wrap gap-3">
            <label className="text-[13px] text-muted">
              {t("common.vehicles")}
              <input className={clsx(numberField, "mt-1 block")} inputMode="numeric" placeholder={t("admin.settings.noLimit")} value={form.newAccountMaxVehicles} onChange={(e) => set("newAccountMaxVehicles", digits(e.target.value))} />
            </label>
            <label className="text-[13px] text-muted">
              {t("admin.settings.general.quotaUsers")}
              <input className={clsx(numberField, "mt-1 block")} inputMode="numeric" placeholder={t("admin.settings.noLimit")} value={form.newAccountMaxUsers} onChange={(e) => set("newAccountMaxUsers", digits(e.target.value))} />
            </label>
          </div>
        </Row>
        <Row title={t("admin.settings.general.modules")} note={t("admin.settings.general.modulesNote")} wide>
          <div className="grid w-full gap-1.5 text-sm sm:grid-cols-2">
            {ALL_MODULES.map((key) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-ink" checked={form.newAccountModules.includes(key)} onChange={() => toggleModule(key)} />
                <span>
                  <span className="num text-muted">{key}</span> · {t(`shared.module.${key}`)}
                </span>
              </label>
            ))}
          </div>
        </Row>
      </Card>

      <Card title={t("admin.settings.general.language")}>
        <Row title={t("admin.settings.general.defaultLanguage")} note={t("admin.settings.general.defaultLanguageNote")}>
          <select className={clsx(inputClass, "w-44")} aria-label={t("admin.settings.general.defaultLanguage")} value={form.defaultLanguage} onChange={(e) => set("defaultLanguage", e.target.value as Language)}>
            {LANGUAGES.map((language) => (
              <option key={language} value={language} lang={language}>
                {LANGUAGE_NAME[language]}
              </option>
            ))}
          </select>
        </Row>
      </Card>

      <Card title={t("admin.settings.general.map")}>
        <Row title={t("admin.settings.general.mapStyle")} note={t("admin.settings.general.mapStyleNote")} wide>
          <input className={field} type="url" value={form.mapStyleUrl} onChange={(e) => set("mapStyleUrl", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.general.geocoder")} note={t("admin.settings.general.geocoderNote")} wide>
          <input className={field} type="url" placeholder={t("admin.settings.general.geocoderOff")} value={form.geocoderUrl} onChange={(e) => set("geocoderUrl", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.general.geocoderAgent")} note={t("admin.settings.general.geocoderAgentNote")} wide>
          <input className={field} placeholder={t("admin.settings.general.geocoderAgentAuto")} value={form.geocoderUserAgent} onChange={(e) => set("geocoderUserAgent", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.general.geocoderInterval")} note={t("admin.settings.general.geocoderIntervalNote")}>
          <input className={numberField} inputMode="numeric" value={form.geocoderIntervalMs} onChange={(e) => set("geocoderIntervalMs", digits(e.target.value))} />
        </Row>
        <Row title={t("admin.settings.general.routing")} note={t("admin.settings.general.routingNote")} wide>
          <input className={field} type="url" placeholder={t("admin.settings.general.routingOff")} value={form.routingUrl} onChange={(e) => set("routingUrl", e.target.value)} />
        </Row>
      </Card>

      <Card title={t("admin.settings.general.data")}>
        <Row title={t("admin.settings.general.claimWindow")} note={t("admin.settings.general.claimWindowNote")}>
          <input className={numberField} inputMode="numeric" value={form.claimWindowMinutes} onChange={(e) => set("claimWindowMinutes", digits(e.target.value))} />
        </Row>
        <Row title={t("admin.settings.general.maxPending")} note={t("admin.settings.general.maxPendingNote")}>
          <input className={numberField} inputMode="numeric" value={form.maxPendingDevices} onChange={(e) => set("maxPendingDevices", digits(e.target.value))} />
        </Row>
        <Row title={t("admin.settings.general.history")} note={t("admin.settings.general.historyNote", { min: HISTORY_RETENTION_MIN_DAYS })}>
          <input className={numberField} inputMode="numeric" placeholder={t("admin.settings.noLimit")} value={form.historyRetentionDays} onChange={(e) => set("historyRetentionDays", digits(e.target.value))} />
        </Row>
        <Row title={t("admin.settings.general.traccarRetention")} note={t("admin.settings.general.traccarRetentionNote")}>
          <input className={numberField} inputMode="numeric" value={form.traccarRetentionDays} onChange={(e) => set("traccarRetentionDays", digits(e.target.value))} />
        </Row>
        <Row title={t("admin.settings.general.maxUpload")} note={t("admin.settings.general.maxUploadNote", { max: UPLOAD_MAX_MB })}>
          <input className={numberField} inputMode="numeric" value={form.maxUploadMb} onChange={(e) => set("maxUploadMb", digits(e.target.value))} />
        </Row>
      </Card>

      <Card title={t("admin.settings.general.operations")}>
        <Row title={t("admin.settings.general.alertEmail")} note={t("admin.settings.general.alertEmailNote")} wide>
          <input className={field} type="email" placeholder={t("admin.settings.general.alertEmailNone")} value={form.alertEmail} onChange={(e) => set("alertEmail", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.general.disk")} note={t("admin.settings.general.diskNote")}>
          <input className={numberField} inputMode="numeric" value={form.diskAlertPercent} onChange={(e) => set("diskAlertPercent", digits(e.target.value))} />
        </Row>
        <Row title={t("admin.settings.general.alertEmailsPerHour")} note={t("admin.settings.general.alertEmailsPerHourNote")}>
          <input className={numberField} inputMode="numeric" value={form.alertEmailsPerHour} onChange={(e) => set("alertEmailsPerHour", digits(e.target.value))} />
        </Row>
      </Card>

      <Card title={t("admin.settings.general.legal")} note={t("admin.settings.general.legalNote")}>
        <Row title={t("admin.settings.general.legalEntity")} note={t("admin.settings.general.legalEntityNote")} wide>
          <input className={field} aria-label={t("admin.settings.general.legalEntity")} maxLength={120} placeholder={t("admin.settings.general.legalContactNone")} value={form.legalEntity} onChange={(e) => set("legalEntity", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.general.legalCountry")} note={t("admin.settings.general.legalCountryNote")} wide>
          <input className={field} aria-label={t("admin.settings.general.legalCountry")} maxLength={80} placeholder={t("admin.settings.general.legalContactNone")} value={form.legalCountry} onChange={(e) => set("legalCountry", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.general.legalContact")} note={t("admin.settings.general.legalContactNote")} wide>
          <input className={field} type="email" aria-label={t("admin.settings.general.legalContact")} placeholder={t("admin.settings.general.legalContactNone")} value={form.legalContactEmail} onChange={(e) => set("legalContactEmail", e.target.value)} />
        </Row>
      </Card>

      <SaveBar dirty={dirty} saving={save.isPending} error={save.error} saved={save.isSuccess}>
        <ResetButton section="general" what={t("admin.settings.general.reset")} />
      </SaveBar>

      <Modal open={confirm} onClose={() => setConfirm(false)} title={t("admin.settings.general.shortenTitle")}>
        <div className="space-y-5">
          <p className="text-[15px] leading-relaxed text-ink-3">
            <Trans i18nKey="admin.settings.general.shortenBody" values={{ days: next.historyRetentionDays }} components={{ strong: <strong /> }} />
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirm(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirm(false);
                save.mutate(next);
              }}
            >
              {t("admin.settings.general.shortenConfirm")}
            </Button>
          </div>
        </div>
      </Modal>
    </form>
  );
}

function PasswordsForm({ current }: { current: PasswordPolicy }) {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState(current);
  const [length, setLength] = useState(String(current.minLength));
  const save = useSaveSection("passwords");
  useEffect(() => {
    setPolicy(current);
    setLength(String(current.minLength));
  }, [current]);
  const next: PasswordPolicy = { ...policy, minLength: Number(length) || PASSWORD_MIN };
  const dirty = JSON.stringify(next) !== JSON.stringify(current);
  const checks: [keyof Omit<PasswordPolicy, "minLength">, string][] = [
    ["number", t("admin.settings.passwords.number")],
    ["symbol", t("admin.settings.passwords.symbol")],
    ["lowercase", t("admin.settings.passwords.lowercase")],
    ["uppercase", t("admin.settings.passwords.uppercase")],
  ];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(next);
      }}
      className="space-y-4"
      noValidate
    >
      <Card title={t("admin.settings.passwords.title")} note={t("admin.settings.passwords.note")}>
        <Row title={t("admin.settings.passwords.minLength")} note={t("admin.settings.passwords.minLengthNote", { min: PASSWORD_MIN })}>
          <input className={numberField} inputMode="numeric" value={length} onChange={(e) => setLength(digits(e.target.value))} />
        </Row>
        <Row title={t("admin.settings.passwords.rules")} note={t("admin.settings.passwords.rulesNote", { hint: sayShared(passwordHint(next)) })} wide>
          <div className="space-y-1.5 text-sm">
            {checks.map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-ink" checked={policy[key]} onChange={(e) => setPolicy({ ...policy, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
        </Row>
      </Card>
      <SaveBar dirty={dirty} saving={save.isPending} error={save.error} saved={save.isSuccess}>
        <ResetButton section="passwords" what={t("admin.settings.passwords.reset")} />
      </SaveBar>
    </form>
  );
}

// ─── Outgoing email ─────────────────────────────────────────────────────────

/** The mail server the platform sends with. It lives inside the email channel. */
export function MailForm({ current, meEmail }: { current: PlatformSettings["mail"]; meEmail: string }) {
  const { t } = useTranslation();
  const start = () => ({ custom: current.custom, host: current.host, port: String(current.port), security: current.security, user: current.user, from: current.from, password: "" });
  const [form, setForm] = useState(start);
  const save = useSaveSection("mail");
  const test = useMutation({ mutationFn: sendTestMail });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the server returns what was saved
  useEffect(() => setForm(start()), [current]);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    test.reset();
    setForm((f) => ({ ...f, [key]: value }));
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(start());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ custom: form.custom, host: form.host.trim(), port: Number(form.port) || 587, security: form.security, user: form.user.trim(), from: form.from.trim(), ...(form.password ? { password: form.password } : {}) });
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Card title={t("admin.settings.mail.title")} note={t("admin.settings.mail.note")}>
        <Row
          title={t("admin.settings.mail.custom")}
          note={form.custom ? t("admin.settings.mail.customOn") : t("admin.settings.mail.customOff")}
        >
          <Switch label={t("admin.settings.mail.custom")} checked={form.custom} onChange={(on) => set("custom", on)} />
        </Row>
        {form.custom && (
          <>
            <Row title={t("admin.settings.mail.server")} note={t("admin.settings.mail.serverNote")} wide>
              <div className="flex w-full flex-wrap gap-2">
                <input className={clsx(inputClass, "min-w-0 flex-1 basis-48")} placeholder={t("admin.settings.mail.hostPlaceholder")} value={form.host} onChange={(e) => set("host", e.target.value)} />
                <input className={clsx(inputClass, "num w-24")} inputMode="numeric" aria-label={t("admin.settings.mail.port")} value={form.port} onChange={(e) => set("port", digits(e.target.value))} />
              </div>
              <select className={field} aria-label={t("admin.settings.mail.security")} value={form.security} onChange={(e) => set("security", e.target.value as MailSecurity)}>
                {MAIL_SECURITIES.map((s) => (
                  <option key={s} value={s}>
                    {t(`shared.mailSecurity.${s}`)}
                  </option>
                ))}
              </select>
            </Row>
            <Row title={t("admin.settings.mail.credentials")} note={t("admin.settings.mail.credentialsNote")} wide>
              <input className={field} placeholder={t("admin.settings.mail.user")} autoComplete="off" value={form.user} onChange={(e) => set("user", e.target.value)} />
              <input className={field} type="password" autoComplete="new-password" placeholder={current.hasPassword ? t("admin.settings.mail.passwordKept") : t("admin.settings.mail.password")} value={form.password} onChange={(e) => set("password", e.target.value)} />
            </Row>
            <Row title={t("admin.settings.mail.from")} note={t("admin.settings.mail.fromNote")} wide>
              <input className={field} placeholder={t("admin.settings.mail.fromPlaceholder")} value={form.from} onChange={(e) => set("from", e.target.value)} />
            </Row>
          </>
        )}
      </Card>
      <SaveBar dirty={dirty} saving={save.isPending} error={save.error} saved={save.isSuccess}>
        <Button type="button" variant="secondary" loading={test.isPending} disabled={dirty} title={dirty ? t("admin.settings.mail.saveFirst") : undefined} onClick={() => test.mutate()}>
          {t("admin.settings.mail.test")}
        </Button>
        <ResetButton section="mail" what={t("admin.settings.mail.reset")} />
      </SaveBar>
      {test.isSuccess && <Notice tone="success">{t("admin.settings.mail.testSent", { to: test.data.sentTo })}</Notice>}
      {test.isError && <Notice tone="error">{errorText(test.error)}</Notice>}
      {!test.isSuccess && !test.isError && <p className="text-[13px] text-muted">{t("admin.settings.mail.testNote", { email: meEmail })}</p>}
    </form>
  );
}

// ─── External storage ──────────────────────────────────────────────────

export function StorageTab() {
  const settings = useSettings();
  if (!settings.data) return <Loading query={settings} />;
  return <StorageForm current={settings.data.storage} />;
}

function StorageForm({ current }: { current: PlatformSettings["storage"] }) {
  const { t } = useTranslation();
  const start = () => ({
    enabled: current.enabled,
    provider: current.provider,
    accessKeyId: current.accessKeyId,
    secret: "",
    bucket: current.bucket,
    region: current.region,
    endpoint: current.endpoint,
    prefix: current.prefix,
    flags: current.flags,
  });
  const [form, setForm] = useState(start);
  const save = useSaveSection("storage");
  const test = useMutation({ mutationFn: testPlatformStorage });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the server returns what was saved
  useEffect(() => setForm(start()), [current]);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    test.reset();
    setForm((f) => ({ ...f, [key]: value }));
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(start());
  /** What is sent: as written, without extra spaces or empty arguments. */
  const payload = () => {
    const { secret, ...rest } = form;
    return {
      ...rest,
      accessKeyId: rest.accessKeyId.trim(),
      bucket: rest.bucket.trim(),
      region: rest.region.trim() || "us-east-1",
      endpoint: rest.endpoint.trim(),
      prefix: rest.prefix.trim(),
      flags: rest.flags.map((f) => f.trim()).filter((f) => f !== ""),
      ...(secret ? { secretAccessKey: secret } : {}),
    };
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(payload());
  };
  const needsEndpoint = storageNeedsEndpoint(form.provider);
  const flagProblems = form.flags.map((f) => (f.trim() === "" ? null : storageFlagProblem(f)));
  // Testing needs the same as connecting; the secret key can be the saved one.
  const missing = form.bucket.trim() === "" || form.accessKeyId.trim() === "" || (needsEndpoint && form.endpoint.trim() === "") || (form.secret === "" && !current.hasSecret);
  const cannotTest = missing ? t("admin.settings.storage.missing") : flagProblems.some(Boolean) ? t("admin.settings.storage.fixFlags") : undefined;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {/* Enabled and without a readable key: the key was encrypted with another server's secret, as happens after restoring one of its backups. */}
      {current.enabled && !current.hasSecret && <Notice>{t("admin.settings.storage.unreadableSecret")}</Notice>}
      <Card title={t("admin.settings.storage.title")} note={t("admin.settings.storage.note")}>
        <Row title={t("admin.settings.storage.enabled")} note={t("admin.settings.storage.enabledNote")}>
          <Switch label={t("admin.settings.storage.enabled")} checked={form.enabled} onChange={(on) => set("enabled", on)} />
        </Row>
        <Row title={t("admin.settings.storage.provider")} note={t("admin.settings.storage.providerNote")} wide>
          <select className={field} aria-label={t("admin.settings.storage.provider")} value={form.provider} onChange={(e) => set("provider", e.target.value)}>
            {STORAGE_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === "Other" || p.id === "Rclone" ? t(`shared.storageProvider.${p.id}`) : p.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title={t("admin.settings.storage.accessKey")} note={t("admin.settings.storage.accessKeyNote")} wide>
          <input className={field} aria-label={t("admin.settings.storage.accessKey")} autoComplete="off" spellCheck={false} value={form.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.storage.secret")} note={t("admin.settings.storage.secretNote")} wide>
          <input className={field} type="password" aria-label={t("admin.settings.storage.secret")} autoComplete="new-password" placeholder={current.hasSecret ? t("admin.settings.storage.secretKept") : ""} value={form.secret} onChange={(e) => set("secret", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.storage.bucket")} note={t("admin.settings.storage.bucketNote")} wide>
          <input className={field} aria-label={t("admin.settings.storage.bucket")} placeholder={t("admin.settings.storage.bucketPlaceholder")} spellCheck={false} value={form.bucket} onChange={(e) => set("bucket", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.storage.region")} note={t("admin.settings.storage.regionNote")} wide>
          <input className={field} aria-label={t("admin.settings.storage.region")} placeholder="us-east-1" spellCheck={false} value={form.region} onChange={(e) => set("region", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.storage.endpoint")} note={needsEndpoint ? t("admin.settings.storage.endpointNote") : t("admin.settings.storage.endpointNoteAws")} wide>
          <input className={field} type="url" aria-label={t("admin.settings.storage.endpoint")} placeholder="https://…" value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} />
        </Row>
        <Row title={t("admin.settings.storage.prefix")} note={t("admin.settings.storage.prefixNote")} wide>
          <input className={field} aria-label={t("admin.settings.storage.prefix")} placeholder="opengps" spellCheck={false} value={form.prefix} onChange={(e) => set("prefix", e.target.value)} />
        </Row>
        <Row
          title={t("admin.settings.storage.flags")}
          note={
            <>
              <Trans i18nKey="admin.settings.storage.flagsNote" components={{ code: <code className="num text-[12.5px]" /> }} />{" "}
              <a className="font-medium text-ink underline underline-offset-2" href="https://rclone.org/s3/#standard-options" target="_blank" rel="noreferrer">
                {t("admin.settings.storage.flagsList")}
              </a>
            </>
          }
          wide
        >
          {form.flags.map((flag, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- arguments have no identity other than their place in the list
            <div key={i} className="w-full">
              <div className="flex w-full gap-2">
                <input
                  className={clsx(inputClass, "num min-w-0 flex-1 text-[13px]", flagProblems[i] && "border-danger")}
                  aria-label={t("admin.settings.storage.flag", { n: i + 1 })}
                  aria-invalid={Boolean(flagProblems[i])}
                  placeholder="--s3-sign-accept-encoding=false"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={flag}
                  onChange={(e) =>
                    set(
                      "flags",
                      form.flags.map((f, j) => (j === i ? e.target.value : f)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="shrink-0 px-3"
                  aria-label={t("admin.settings.storage.removeFlag", { n: i + 1 })}
                  title={t("common.remove")}
                  onClick={() =>
                    set(
                      "flags",
                      form.flags.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash size={16} aria-hidden="true" />
                </Button>
              </div>
              {flagProblems[i] && <p className="mt-1 text-[13px] text-danger">{sayShared(flagProblems[i])}.</p>}
            </div>
          ))}
          <Button type="button" variant="secondary" size="sm" disabled={form.flags.length >= STORAGE_FLAGS_MAX} onClick={() => set("flags", [...form.flags, ""])}>
            <Plus size={15} aria-hidden="true" />
            {t("admin.settings.storage.addFlag")}
          </Button>
        </Row>
      </Card>
      <SaveBar dirty={dirty} saving={save.isPending} error={save.error} saved={save.isSuccess}>
        <Button type="button" variant="secondary" loading={test.isPending} disabled={Boolean(cannotTest)} title={cannotTest} onClick={() => test.mutate(payload())}>
          {t("admin.settings.storage.test")}
        </Button>
        <ResetButton section="storage" what={t("admin.settings.storage.reset")} />
      </SaveBar>
      {test.isSuccess && <Notice tone="success">{dirty ? t("admin.settings.storage.testOkUnsaved") : t("admin.settings.storage.testOk")}</Notice>}
      {test.isError && <Notice tone="error">{errorText(test.error)}</Notice>}
    </form>
  );
}
