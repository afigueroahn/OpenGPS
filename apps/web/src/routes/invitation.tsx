// Invitation link page: shows what it is about and accepts it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Link, Navigate, useSearchParams } from "react-router";
import { Button, Notice, Spinner } from "../components/ui";
import { ApiRequestError, acceptInvitation, auth, getInvitation } from "../lib/api";
import { useMe } from "../lib/session";
import { AuthLayout, TextLink } from "./auth";

export function Invitation() {
  const [params] = useSearchParams();
  const id = params.get("id") ?? "";
  const me = useMe();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const invitation = useQuery({ queryKey: ["invitation", id], queryFn: () => getInvitation(id), enabled: id !== "", retry: false });

  const accept = useMutation({
    mutationFn: () => acceptInvitation(id),
    // The active account changed: everything is reloaded from the start.
    onSuccess: () => window.location.assign("/"),
  });
  const signOut = async () => {
    await auth.signOut().catch(() => {});
    queryClient.clear();
    window.location.reload();
  };

  if (!id) return <Navigate to="/" replace />;
  if (invitation.isLoading || me.isLoading) {
    return (
      <AuthLayout title={t("pages.invitation.title")}>
        <Spinner />
      </AuthLayout>
    );
  }
  if (invitation.isError || !invitation.data) {
    return (
      <AuthLayout title={t("pages.invitation.notFound")} footer={<TextLink to="/">{t("pages.invitation.home")}</TextLink>}>
        <p className="text-[15px] text-ink-3">{t("pages.invitation.notFoundText")}</p>
      </AuthLayout>
    );
  }

  const inv = invitation.data;
  const next = `/invitation?id=${encodeURIComponent(id)}`;
  const title = t("pages.invitation.invited", { account: inv.accountName });

  if (inv.status !== "pending") {
    const message =
      inv.status === "accepted"
        ? t("pages.invitation.accepted")
        : inv.status === "expired"
          ? t("pages.invitation.expired")
          : t("pages.invitation.revoked");
    return (
      <AuthLayout title={title} footer={<TextLink to="/">{t("pages.invitation.myVehicles")}</TextLink>}>
        <Notice tone={inv.status === "accepted" ? "success" : "info"}>{message}</Notice>
      </AuthLayout>
    );
  }

  const lead = (
    <Trans i18nKey="pages.invitation.lead" values={{ inviter: inv.inviterName, role: inv.roleName }} components={{ b: <strong className="font-semibold text-ink" /> }} />
  );

  // No session: first sign in or create the account with the invited email.
  if (!me.data) {
    return (
      <AuthLayout title={title} lead={lead}>
        <div className="space-y-4">
          <p className="text-[15px] text-ink-3">
            <Trans i18nKey="pages.invitation.forEmail" values={{ email: inv.email }} components={{ b: <strong className="font-semibold text-ink" /> }} />
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to={`/signup?next=${encodeURIComponent(next)}`}>
              <Button size="lg">{t("pages.invitation.signUp")}</Button>
            </Link>
            <Link to={`/login?next=${encodeURIComponent(next)}`}>
              <Button size="lg" variant="secondary">
                {t("pages.invitation.signIn")}
              </Button>
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  // Signed in with a different email: the invitation is not for this person.
  if (me.data.user.email.toLowerCase() !== inv.email.toLowerCase()) {
    return (
      <AuthLayout title={title} lead={lead}>
        <div className="space-y-4">
          <Notice tone="info">{t("pages.invitation.otherEmail", { email: inv.email, current: me.data.user.email })}</Notice>
          <Button variant="secondary" onClick={signOut}>
            {t("pages.invitation.signOut")}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={title} lead={lead}>
      <div className="space-y-4">
        {accept.isError && (
          <Notice tone="error">{accept.error instanceof ApiRequestError ? accept.error.message : t("pages.invitation.acceptFailed")}</Notice>
        )}
        <Button size="lg" full loading={accept.isPending} onClick={() => accept.mutate()}>
          {t("pages.invitation.accept")}
        </Button>
        <p className="text-sm text-muted">{t("pages.invitation.ownAccount")}</p>
      </div>
    </AuthLayout>
  );
}
