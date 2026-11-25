// Session screens: sign in, create account, confirm email and password.
import { useQueryClient } from "@tanstack/react-query";
import i18n, { sayShared } from "../lib/i18n";
import { MailCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { BrandMark } from "../components/BrandMark";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { Button, Field, Logo, Notice } from "../components/ui";
import { ApiRequestError, auth, authMessage, safeNext } from "../lib/api";
import { type OAuthProvider, PASSWORD_POLICY_DEFAULT, passwordHint, passwordProblem } from "@opengps/shared";
import { useConfig, useMe } from "../lib/session";

export function AuthLayout({ title, lead, children, footer }: { title: string; lead?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  // Whoever operates this installation, from the server settings.
  const operator = useConfig().data?.legal.entity;
  const { t } = useTranslation();
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="on-dark relative hidden overflow-hidden bg-ink text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <RouteArt />
        <div className="relative">
          <Logo dark size={34} />
        </div>
        <div className="relative max-w-[26rem]">
          <p className="text-[34px] font-semibold leading-[1.12] tracking-tight">{t("pages.auth.headline")}</p>
          <p className="mt-4 text-[16px] leading-relaxed text-white/65">{t("pages.auth.pitch")}</p>
        </div>
        <p className="relative text-[13px] text-white/40">{operator ? t("pages.auth.operator", { operator }) : ""}</p>
      </aside>

      <main className="flex min-h-full flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-[400px]">
          <div className="mb-10 lg:hidden">
            <Logo />
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
          {lead && <p className="mt-2 text-[15px] text-muted">{lead}</p>}
          <div className="mt-7">{children}</div>
          {footer && <p className="mt-7 text-sm text-muted">{footer}</p>}
          <p className="mt-10 text-[13px] text-faint">
            <a href="/terms" className="hover:text-ink-3 hover:underline">
              {t("pages.auth.terms")}
            </a>{" "}
            ·{" "}
            <a href="/privacy" className="hover:text-ink-3 hover:underline">
              {t("pages.auth.privacy")}
            </a>
          </p>
          {/* Before signing in there is nobody to save the choice for: it stays in this browser. */}
          <LanguageSwitch signedIn={false} className="mt-4 max-w-[220px]" />
        </div>
      </main>
    </div>
  );
}

/** A trip drawn over a grid, as a background. */
function RouteArt() {
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 800" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
      <defs>
        <pattern id="cuadricula" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M48 0H0V48" fill="none" stroke="#ffffff" strokeOpacity="0.05" />
        </pattern>
      </defs>
      <rect width="600" height="800" fill="url(#cuadricula)" />
      <path
        d="M-30 330 C 90 320, 130 250, 230 235 S 350 210, 380 150 S 470 70, 640 40"
        fill="none"
        stroke="#3ddc97"
        strokeOpacity="0.9"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="1 11"
      />
      <circle cx="230" cy="235" r="5" fill="#101623" stroke="#3ddc97" strokeWidth="2.5" />
      <circle cx="380" cy="150" r="5" fill="#101623" stroke="#3ddc97" strokeWidth="2.5" />
      <circle cx="505" cy="80" r="22" fill="#3ddc97" fillOpacity="0.14" />
      <circle cx="505" cy="80" r="8" fill="#3ddc97" />
    </svg>
  );
}

export const TextLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="font-semibold text-ink underline decoration-ink/25 underline-offset-4 hover:decoration-ink">
    {children}
  </Link>
);

/** With an open session, the sign-in screens go straight to the map. */
function useRedirectIfSignedIn() {
  const me = useMe();
  const next = useNext();
  return me.data ? <Navigate to={next ?? "/"} replace /> : null;
}

/** Destination requested with ?next=, for example the invitation that was being opened. */
function useNext(): string | null {
  const [params] = useSearchParams();
  return safeNext(params.get("next"));
}
const withNext = (path: string, next: string | null) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

/** Why a trip to another service came back without a session, from what it says on the way back. */
function serviceProblem(params: URLSearchParams): string | null {
  if (params.get("via") !== "oauth" || !params.has("error")) return null;
  const error = params.get("error") ?? "";
  // The platform's own reasons (the terms, registration closed) come already worded.
  if (error === "LEGAL_NOT_ACCEPTED" || error === "REGISTRATION_CLOSED") return params.get("error_description") || i18n.t("pages.auth.services.failed");
  if (error === "account_not_linked") return i18n.t("pages.auth.services.notLinked");
  if (error === "email_not_found") return i18n.t("pages.auth.services.noEmail");
  if (error === "access_denied") return i18n.t("pages.auth.services.cancelled");
  return i18n.t("pages.auth.services.failed");
}

/**
 * The buttons to sign in with the services the platform has. Whoever has no account yet gets one when they come
 * back: the terms are shown right under the buttons, and continuing accepts them.
 */
function ServiceButtons({ from, next }: { from: "login" | "signup"; next: string | null }) {
  const { t } = useTranslation();
  const buttons = useConfig().data?.signIn ?? [];
  const [going, setGoing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (buttons.length === 0) return null;
  const go = async (id: OAuthProvider) => {
    setGoing(id);
    setError(null);
    try {
      const { url } = await auth.social(id, { from, next });
      window.location.assign(url);
    } catch (err) {
      setError(authMessage(err));
      setGoing(null);
    }
  };
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3 py-1 text-[13px] text-muted">
        <span className="h-px flex-1 bg-line" />
        {t(from === "signup" ? "pages.auth.services.orSignUp" : "pages.auth.services.orSignIn")}
        <span className="h-px flex-1 bg-line" />
      </div>
      {buttons.map((b) => (
        <button
          key={b.id}
          type="button"
          disabled={going !== null}
          onClick={() => void go(b.id)}
          className="flex h-11 w-full items-center justify-center gap-2.5 rounded-[12px] border border-line bg-surface px-4 text-[14.5px] font-medium text-ink transition-colors hover:border-faint disabled:opacity-60"
        >
          <BrandMark id={b.id} />
          {t("pages.auth.services.with", { name: b.name })}
        </button>
      ))}
      <p className="pt-1 text-[12.5px] leading-relaxed text-muted">
        <Trans
          i18nKey="pages.auth.services.terms"
          components={{
            terms: <a href="/terms" target="_blank" rel="noreferrer" className="font-medium text-ink-3 underline decoration-ink/25 underline-offset-2 hover:decoration-ink" />,
            privacy: <a href="/privacy" target="_blank" rel="noreferrer" className="font-medium text-ink-3 underline decoration-ink/25 underline-offset-2 hover:decoration-ink" />,
          }}
        />
      </p>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export function Login() {
  const redirect = useRedirectIfSignedIn();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const next = useNext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation();
  if (redirect) return redirect;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.signIn({ email: email.trim(), password });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate(next ?? "/", { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "EMAIL_NOT_VERIFIED") {
        navigate("/check-email", { state: { email: email.trim(), resent: true, next } });
        return;
      }
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // If the verification link fails, it returns here with ?error=…; a trip to another service, with ?via=oauth too.
  const service = serviceProblem(params);
  const linkFailed = params.has("error") && params.get("via") !== "oauth";
  return (
    <AuthLayout
      title={t("pages.auth.login.title")}
      footer={
        <>
          {t("pages.auth.login.noAccount")} <TextLink to={withNext("/signup", next)}>{t("pages.auth.login.signUp")}</TextLink>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {linkFailed && <Notice tone="error">{t("pages.auth.login.linkFailed")}</Notice>}
        {service && <Notice tone="error">{service}</Notice>}
        {params.has("reset") && <Notice tone="success">{t("pages.auth.login.passwordChanged")}</Notice>}
        <Field label={t("pages.auth.email")} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <Field
          label={t("pages.auth.password")}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" size="lg" full loading={busy}>
          {t("pages.auth.login.submit")}
        </Button>
        <p className="text-center text-sm">
          <TextLink to="/forgot-password">{t("pages.auth.login.forgot")}</TextLink>
        </p>
      </form>
      <div className="mt-6">
        <ServiceButtons from="login" next={next} />
      </div>
    </AuthLayout>
  );
}

export function Register() {
  const redirect = useRedirectIfSignedIn();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = useNext();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = useConfig();
  // What is required of the password is set by whoever administers the platform.
  const policy = config.data?.passwordPolicy ?? PASSWORD_POLICY_DEFAULT;
  const { t } = useTranslation();
  if (redirect) return redirect;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return setError(t("pages.auth.register.nameMissing"));
    const weak = passwordProblem(password, policy);
    if (weak) return setError(sayShared(weak));
    if (!accepted) return setError(t("pages.auth.register.mustAccept"));
    setBusy(true);
    setError(null);
    try {
      const created = await auth.signUp({ name: name.trim(), email: email.trim(), password }, next);
      // The first account of an installation without mail needs no confirmation: it goes straight in.
      if (created?.user?.emailVerified) {
        await auth.signIn({ email: email.trim(), password });
        await queryClient.invalidateQueries({ queryKey: ["me"] });
        navigate(next ?? "/", { replace: true });
        return;
      }
      navigate("/check-email", { state: { email: email.trim(), next } });
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t("pages.auth.register.title")}
      lead={t("pages.auth.register.lead")}
      footer={
        <>
          {t("pages.auth.register.haveAccount")} <TextLink to={withNext("/login", next)}>{t("pages.auth.register.signIn")}</TextLink>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {config.data?.registrationOpen === false && <Notice>{t("pages.auth.register.closed")}</Notice>}
        {serviceProblem(params) && <Notice tone="error">{serviceProblem(params)}</Notice>}
        <Field label={t("pages.auth.register.name")} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Field label={t("pages.auth.email")} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label={t("pages.auth.password")}
          type="password"
          autoComplete="new-password"
          required
          minLength={policy.minLength}
          hint={sayShared(passwordHint(policy))}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label className="flex items-start gap-2.5 text-sm text-ink-3">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>
            <Trans
              i18nKey="pages.auth.register.accept"
              components={{
                terms: <a href="/terms" target="_blank" rel="noreferrer" className="font-semibold text-ink underline decoration-ink/25 underline-offset-4 hover:decoration-ink" />,
                privacy: <a href="/privacy" target="_blank" rel="noreferrer" className="font-semibold text-ink underline decoration-ink/25 underline-offset-4 hover:decoration-ink" />,
              }}
            />
          </span>
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" size="lg" full loading={busy}>
          {t("pages.auth.register.submit")}
        </Button>
      </form>
      <div className="mt-6">
        <ServiceButtons from="signup" next={next} />
      </div>
    </AuthLayout>
  );
}

export function CheckEmail() {
  const { state } = useLocation() as { state: { email?: string; resent?: boolean; next?: string | null } | null };
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const { t } = useTranslation();
  if (!state?.email) return <Navigate to="/login" replace />;
  const email = state.email;

  const resend = async () => {
    setStatus("sending");
    try {
      await auth.resendVerification(email, state?.next);
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  };

  return (
    <AuthLayout title={t("pages.auth.checkEmail.title")} footer={<TextLink to="/login">{t("pages.auth.backToLogin")}</TextLink>}>
      <div className="space-y-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-signal/20 text-signal-ink">
          <MailCheck size={22} />
        </div>
        <p className="text-[15px] text-ink-3">
          <Trans
            i18nKey={state.resent ? "pages.auth.checkEmail.resent" : "pages.auth.checkEmail.sent"}
            values={{ email }}
            components={{ b: <strong className="font-semibold text-ink" /> }}
          />
        </p>
        <p className="text-sm text-muted">{t("pages.auth.checkEmail.slow")}</p>
        {status === "sent" && <Notice tone="success">{t("pages.auth.checkEmail.resentOk")}</Notice>}
        {status === "error" && <Notice tone="error">{t("pages.auth.checkEmail.resendFailed")}</Notice>}
        <Button variant="secondary" onClick={resend} loading={status === "sending"}>
          {t("pages.auth.checkEmail.resend")}
        </Button>
      </div>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t("pages.auth.forgot.title")}
      lead={t("pages.auth.forgot.lead")}
      footer={<TextLink to="/login">{t("pages.auth.backToLogin")}</TextLink>}
    >
      {sent ? (
        <Notice tone="success">{t("pages.auth.forgot.sent")}</Notice>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label={t("pages.auth.email")} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" size="lg" full loading={busy}>
            {t("pages.auth.forgot.submit")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = useConfig().data?.passwordPolicy ?? PASSWORD_POLICY_DEFAULT;
  const { t } = useTranslation();

  if (!token || params.has("error")) {
    return (
      <AuthLayout title={t("pages.auth.reset.invalidTitle")} footer={<TextLink to="/login">{t("pages.auth.backToLogin")}</TextLink>}>
        <div className="space-y-4">
          <p className="text-[15px] text-ink-3">{t("pages.auth.reset.invalidText")}</p>
          <Link to="/forgot-password">
            <Button>{t("pages.auth.reset.requestNew")}</Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const weak = passwordProblem(password, policy);
    if (weak) return setError(sayShared(weak));
    setBusy(true);
    setError(null);
    try {
      await auth.resetPassword(token, password);
      navigate("/login?reset=1", { replace: true });
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t("pages.auth.reset.title")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          label={t("pages.auth.reset.password")}
          type="password"
          autoComplete="new-password"
          required
          minLength={policy.minLength}
          hint={sayShared(passwordHint(policy))}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" size="lg" full loading={busy}>
          {t("pages.auth.reset.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
