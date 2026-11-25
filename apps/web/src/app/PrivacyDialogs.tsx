// Privacy dialogs: accept the current terms and delete the account.
import { type Me, confirmWord, isConfirmWord } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice } from "../components/ui";
import { acceptLegal, auth, authMessage } from "../lib/api";
import { currentLanguage } from "../lib/i18n";

const link = "font-semibold text-ink underline decoration-ink/25 underline-offset-4 hover:decoration-ink";

/** Shown to those who have not yet accepted the current version. It cannot be closed without deciding. */
export function ConsentDialog({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accept = useMutation({ mutationFn: acceptLegal, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }) });
  const signOut = async () => {
    await auth.signOut().catch(() => {});
    window.location.assign("/login");
  };
  return (
    <Modal open={open} onClose={() => {}} title={t("map.privacy.consent.title")} required>
      <div className="space-y-4">
        <p className="text-[15px] leading-relaxed text-ink-3">
          <Trans
            i18nKey="map.privacy.consent.body"
            components={{
              terms: <a href="/terms" target="_blank" rel="noreferrer" className={link} />,
              privacy: <a href="/privacy" target="_blank" rel="noreferrer" className={link} />,
            }}
          />
        </p>
        {accept.isError && <Notice tone="error">{t("map.privacy.consent.failed")}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={signOut}>
            {t("map.privacy.consent.decline")}
          </Button>
          <Button loading={accept.isPending} onClick={() => accept.mutate()}>
            {t("map.privacy.consent.accept")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Delete the user and everything that was theirs. Asks for the password or, to whoever has none, to type a word. */
export function DeleteAccountDialog({ open, onClose, me }: { open: boolean; onClose: () => void; me: Me }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
    }
  }, [open]);

  const remove = useMutation({
    mutationFn: () => auth.deleteAccount(me.user.hasPassword ? password : null),
    onSuccess: () => window.location.assign("/login"),
    onError: (err) => setError(authMessage(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (me.user.hasPassword ? password : isConfirmWord("deleteAccount", password)) remove.mutate();
  };
  const word = confirmWord("deleteAccount", currentLanguage());

  return (
    <Modal open={open} onClose={onClose} title={t("map.privacy.delete.title")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="space-y-2 text-[15px] leading-relaxed text-ink-3">
          <p>
            <Trans i18nKey="map.privacy.delete.intro" values={{ email: me.user.email }} components={{ b: <strong className="font-semibold text-ink" /> }} />
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("map.privacy.delete.vehicles")}</li>
            <li>{t("map.privacy.delete.people")}</li>
          </ul>
          <p>{t("map.privacy.delete.final")}</p>
        </div>
        {me.user.hasPassword ? (
          <Field label={t("map.privacy.delete.password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        ) : (
          <Field label={t("map.privacy.delete.typeWord", { word })} hint={t("map.privacy.delete.noPassword")} autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" loading={remove.isPending} disabled={me.user.hasPassword ? !password : !isConfirmWord("deleteAccount", password)}>
            {t("map.privacy.delete.confirm")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
