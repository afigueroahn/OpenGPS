// The page the mobile app opens to create a passkey (ADR-0023), in the system's sign-in window and without the
// app's session: the person signs in again here, so the session is fresh, creates the passkey with Face ID, and this
// window's session is closed before going back to the app.
import { APP_PASSKEY_PAGE, APP_PASSKEY_RETURN } from "@opengps/shared";
import { useMutation } from "@tanstack/react-query";
import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
import { Button, Field, Notice, Spinner } from "../components/ui";
import { ApiRequestError, auth } from "../lib/api";
import { createPasskey, passkeyMessage, passkeysInBrowser } from "../lib/passkeys";
import { useConfig, useMe } from "../lib/session";
import { AuthLayout } from "./auth";

const SIGN_IN = `/login?next=${encodeURIComponent(APP_PASSKEY_PAGE)}`;

/** A first name for the passkey: the kind of device, which the person can change. */
const deviceName = () => (/iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android" : "");

/** This window's session is closed, and the app is told how it went. */
async function backToApp(query: string): Promise<void> {
  await auth.signOut().catch(() => {});
  window.location.assign(`${APP_PASSKEY_RETURN}?${query}`);
}

export function AppPasskey() {
  const { t } = useTranslation();
  const me = useMe();
  const config = useConfig();
  const navigate = useNavigate();
  const [name, setName] = useState(deviceName);
  const create = useMutation({ mutationFn: () => createPasskey(name), onSuccess: () => backToApp("created=1") });
  const title = t("pages.appPasskey.title");

  if (me.isLoading || config.isLoading) {
    return (
      <AuthLayout title={title}>
        <Spinner />
      </AuthLayout>
    );
  }
  if (!config.data?.passkeys || !passkeysInBrowser()) {
    return (
      <AuthLayout title={title}>
        <div className="space-y-4">
          <Notice tone="info">{t("pages.appPasskey.unavailable")}</Notice>
          <Button size="lg" full onClick={() => void backToApp("error=unavailable")}>
            {t("pages.appPasskey.back")}
          </Button>
        </div>
      </AuthLayout>
    );
  }
  // Without a session, the person signs in the usual ways and comes back here.
  if (!me.data) return <Navigate to={SIGN_IN} replace />;

  const notFresh = create.error instanceof ApiRequestError && create.error.code === "SESSION_NOT_FRESH";
  const problem = create.isError ? passkeyMessage(create.error) : null;
  return (
    <AuthLayout
      title={title}
      lead={<Trans i18nKey="pages.appPasskey.lead" values={{ email: me.data.user.email }} components={{ b: <strong className="font-semibold text-ink" /> }} />}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label={t("passkeys.name")} placeholder={t("passkeys.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        {problem && <Notice tone="error">{problem}</Notice>}
        {notFresh ? (
          <Button
            type="button"
            size="lg"
            full
            onClick={async () => {
              await auth.signOut().catch(() => {});
              navigate(SIGN_IN, { replace: true });
            }}
          >
            {t("pages.appPasskey.signInAgain")}
          </Button>
        ) : (
          <Button type="submit" size="lg" full loading={create.isPending || create.isSuccess}>
            <Fingerprint size={18} aria-hidden="true" /> {t("passkeys.create")}
          </Button>
        )}
        <Button type="button" size="lg" full variant="secondary" disabled={create.isPending || create.isSuccess} onClick={() => void backToApp("error=access_denied")}>
          {t("pages.appSignIn.cancel")}
        </Button>
      </form>
    </AuthLayout>
  );
}
