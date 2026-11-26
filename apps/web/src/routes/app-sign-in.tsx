// The page the mobile app's sign-in window shows on coming back from another service (ADR-0014): the person
// confirms the account they go back to the app with, and only then the platform hands out the pass.
import { APP_SCHEME } from "@opengps/shared";
import { useMutation } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../components/ui";
import { ApiRequestError, appPass } from "../lib/api";
import { useMe } from "../lib/session";
import { AuthLayout } from "./auth";

/** Back to the app without a pass, with the reason: the app tells the person. */
const backWithout = (error: string) => window.location.assign(`${APP_SCHEME}://oauth?error=${error}`);

export function AppSignIn() {
  const me = useMe();
  const { t } = useTranslation();
  const pass = useMutation({ mutationFn: appPass, onSuccess: ({ url }) => window.location.assign(url) });
  const title = t("pages.appSignIn.title");

  if (me.isLoading) {
    return (
      <AuthLayout title={title}>
        <Spinner />
      </AuthLayout>
    );
  }
  const expired = !me.data || (pass.error instanceof ApiRequestError && pass.error.status === 401);
  if (expired) {
    return (
      <AuthLayout title={title}>
        <div className="space-y-4">
          <Notice tone="info">{t("pages.appSignIn.expired")}</Notice>
          <Button size="lg" full onClick={() => backWithout("no_session")}>
            {t("pages.appSignIn.confirm")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={title}
      lead={<Trans i18nKey="pages.appSignIn.lead" values={{ email: me.data?.user.email }} components={{ b: <strong className="font-semibold text-ink" /> }} />}
    >
      <div className="space-y-4">
        {pass.isError && <Notice tone="error">{t("pages.appSignIn.failed")}</Notice>}
        <Button size="lg" full loading={pass.isPending || pass.isSuccess} onClick={() => pass.mutate()}>
          {t("pages.appSignIn.confirm")}
        </Button>
        <Button size="lg" full variant="secondary" disabled={pass.isPending || pass.isSuccess} onClick={() => backWithout("access_denied")}>
          {t("pages.appSignIn.cancel")}
        </Button>
        <p className="text-sm text-muted">{t("pages.appSignIn.notYou")}</p>
      </div>
    </AuthLayout>
  );
}
