// Vehicle security: two-step engine lock and recovery mode.
import { COMMAND_TTL_MIN, LOCK_MAX_SPEED_KMH, type Vehicle, type VehicleCommand, type VehicleSecurity, confirmWord, isConfirmWord } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { LifeBuoy, Lock, LockOpen } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, CopyText, Field, Modal, Notice, Spinner } from "../../components/ui";
import { cancelLock, getSecurity, prepareLock, sendLock, setRecovery, shareUrl } from "../../lib/api";
import { formatDateTime, formatDuration, formatSpeed, timeAgo } from "../../lib/format";
import i18n, { currentLanguage } from "../../lib/i18n";
import { errorText } from "../widgets";

type Action = "lock" | "unlock";

export function SecurityCard({ vehicle, canCommand, now }: { vehicle: Vehicle; canCommand: boolean; now: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = ["security", vehicle.id];
  const security = useQuery({
    queryKey: key,
    queryFn: () => getSecurity(vehicle.id),
    // While a command is in progress it is polled often, in case the live notification does not arrive.
    refetchInterval: (query) => (query.state.data?.pending ? 5000 : false),
  });
  const [action, setAction] = useState<Action | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const put = (data: VehicleSecurity) => queryClient.setQueryData(key, data);

  const cancel = useMutation({ mutationFn: () => cancelLock(vehicle.id), onSuccess: put });
  const recovery = useMutation({
    mutationFn: (on: boolean) => setRecovery(vehicle.id, on),
    onSuccess: (result) => {
      put(result.security);
      setConfirmOff(false);
      if (result.shareToken) setLink(shareUrl(result.shareToken));
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
    },
  });

  const s = security.data;
  if (security.isLoading) {
    return (
      <div className="mt-3 flex h-16 items-center justify-center rounded-[12px] bg-ink-2 text-white/50">
        <Spinner />
      </div>
    );
  }
  if (!s) return null;
  const locked = s.lock?.state === "locked";
  const pending = s.pending;
  const last: VehicleCommand | undefined = s.commands[0];

  return (
    <>
      <div className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3">
        <div className="flex items-start gap-3">
          {locked ? <Lock size={18} className="mt-0.5 shrink-0 text-coral" aria-hidden="true" /> : <LockOpen size={18} className="mt-0.5 shrink-0 text-white/45" aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{locked ? t("security.lock.locked") : t("security.lock.unlocked")}</p>
            <p className="text-[13px] leading-snug text-white/55">{lockNote(s, now)}</p>
          </div>
        </div>

        {pending && (
          <div className="mt-3 rounded-[10px] bg-ink px-3 py-2.5">
            <p className="text-[13px] font-semibold text-apricot">
              {t(pending.kind === "lock" ? "security.pending.lock" : "security.pending.unlock", { status: t(`shared.commandStatus.${pending.status}`).toLowerCase() })}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-white/60">
              {pending.status === "waiting"
                ? t("security.pending.expires", {
                    note: pending.note ?? t("security.pending.waiting"),
                    minutes: Math.max(1, Math.round((Date.parse(pending.expiresAt) - now) / 60_000)),
                  })
                : t("security.pending.sent")}
            </p>
            {canCommand && pending.status === "waiting" && (
              <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()} className="mt-2 text-[13px] font-semibold text-white underline underline-offset-2 disabled:opacity-50">
                {t("security.pending.cancel")}
              </button>
            )}
          </div>
        )}
        {!pending && last && (last.status === "expired" || last.status === "failed" || last.status === "unconfirmed") && (
          <p className="mt-3 text-[13px] leading-snug text-apricot">
            {last.note
              ? t(last.kind === "lock" ? "security.lastFailed.lockNote" : "security.lastFailed.unlockNote", {
                  status: t(`shared.commandStatus.${last.status}`).toLowerCase(),
                  note: last.note.toLowerCase(),
                })
              : t(last.kind === "lock" ? "security.lastFailed.lock" : "security.lastFailed.unlock", { status: t(`shared.commandStatus.${last.status}`).toLowerCase() })}
          </p>
        )}
        {cancel.isError && <p className="mt-2 text-[13px] text-coral">{errorText(cancel.error)}</p>}

        {s.lockSupported === false && <p className="mt-3 text-[13px] leading-snug text-white/55">{t("security.lock.unsupported")}</p>}
        {s.lockSupported === null && <p className="mt-3 text-[13px] leading-snug text-white/55">{t("security.lock.supportUnknown")}</p>}
        {canCommand && s.lockSupported && !pending && (
          <button
            type="button"
            onClick={() => setAction(locked ? "unlock" : "lock")}
            className={clsx(
              "mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-[10px] text-sm font-semibold transition-colors",
              locked ? "bg-signal text-ink hover:bg-mint" : "bg-ink text-coral hover:bg-ink-3",
            )}
          >
            {locked ? <LockOpen size={15} /> : <Lock size={15} />} {locked ? t("security.lock.unlockStart") : t("security.lock.lockStart")}
          </button>
        )}
      </div>

      <div className="mt-3 rounded-[12px] bg-ink-2 px-4 py-3">
        <div className="flex items-center gap-3">
          <LifeBuoy size={18} className={clsx("shrink-0", s.recovery ? "text-signal" : "text-white/45")} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("security.recovery.title")}</p>
            <p className="text-[13px] leading-snug text-white/55">
              {s.recovery ? t("security.recovery.active", { since: timeAgo(s.recovery.since, now) }) : t("security.recovery.inactive")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(s.recovery)}
            aria-label={t("security.recovery.title")}
            disabled={!canCommand || recovery.isPending}
            onClick={() => (s.recovery ? setConfirmOff(true) : recovery.mutate(true))}
            className={clsx("relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50", s.recovery ? "bg-signal" : "bg-ink-3")}
          >
            <span className={clsx("absolute top-1 h-5 w-5 rounded-full bg-white transition-all", s.recovery ? "left-6" : "left-1")} />
          </button>
        </div>
        {recovery.isError && <p className="mt-2 text-[13px] text-coral">{errorText(recovery.error)}</p>}
      </div>

      {action && <LockDialog vehicle={vehicle} action={action} onClose={() => setAction(null)} onDone={put} />}

      <Modal open={link !== null} onClose={() => setLink(null)} title={t("security.recovery.linkTitle")}>
        <div className="space-y-4">
          <p className="text-[15px] leading-relaxed text-ink-3">
            <Trans i18nKey="security.recovery.linkBody" values={{ name: vehicle.name }} components={{ b: <strong className="font-semibold text-ink" /> }} />
          </p>
          {link && <CopyText value={link} label={t("security.recovery.linkLabel")} />}
          <Notice tone="info">{t("security.recovery.copyNow")}</Notice>
          <div className="flex justify-end">
            <Button onClick={() => setLink(null)}>{t("common.done")}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={confirmOff} onClose={() => setConfirmOff(false)} title={t("security.recovery.offTitle")}>
        <div className="space-y-5">
          <p className="text-[15px] leading-relaxed text-ink-3">{t("security.recovery.offBody")}</p>
          {recovery.isError && <Notice tone="error">{errorText(recovery.error)}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOff(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" loading={recovery.isPending} onClick={() => recovery.mutate(false)}>
              {t("security.recovery.off")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function lockNote(s: VehicleSecurity, now: number): string {
  if (!s.lock) return i18n.t("security.note.never");
  const when = timeAgo(s.lock.changedAt, now);
  if (s.lock.state === "locked") return s.lock.confirmed ? i18n.t("security.note.lockConfirmed", { when }) : i18n.t("security.note.lockSent", { when });
  return s.lock.confirmed ? i18n.t("security.note.unlockConfirmed", { when }) : i18n.t("security.note.unlockSent", { when });
}

/** The two lock steps: see what condition the vehicle is in and type the word. */
function LockDialog({ vehicle, action, onClose, onDone }: { vehicle: Vehicle; action: Action; onClose: () => void; onDone: (s: VehicleSecurity) => void }) {
  const { t } = useTranslation();
  const [word, setWord] = useState("");
  // The check is requested each time it opens: it describes the vehicle at that moment.
  const check = useQuery({ queryKey: ["lock-check", vehicle.id, action], queryFn: () => prepareLock(vehicle.id, action), gcTime: 0, staleTime: 0, retry: false });
  useEffect(() => setWord(""), [action]);
  const send = useMutation({
    mutationFn: () => sendLock(vehicle.id, { action, confirmToken: check.data?.confirmToken ?? "", word: word.trim() }),
    onSuccess: (s) => {
      onDone(s);
      onClose();
    },
  });
  const expected = confirmWord(action, currentLanguage());
  const ready = isConfirmWord(action, word) && check.isSuccess;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) send.mutate();
  };
  const lock = action === "lock";

  return (
    <Modal open onClose={onClose} title={lock ? t("security.lock.lockStart") : t("security.lock.unlockStart")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-[15px] leading-relaxed text-ink-3">
          {lock ? (
            <Trans
              i18nKey="security.dialog.lockBody"
              values={{ name: vehicle.name, speed: LOCK_MAX_SPEED_KMH }}
              components={{ b: <strong className="font-semibold text-ink" /> }}
            />
          ) : (
            <Trans i18nKey="security.dialog.unlockBody" values={{ name: vehicle.name }} components={{ b: <strong className="font-semibold text-ink" /> }} />
          )}
        </p>

        {check.isLoading && (
          <div className="flex h-20 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {check.isError && <Notice tone="error">{errorText(check.error)}</Notice>}
        {check.data && (
          <>
            <dl className="grid grid-cols-2 gap-3 rounded-[12px] bg-canvas px-4 py-3">
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("security.dialog.speedNow")}</dt>
                <dd className="num mt-0.5 text-[17px] font-semibold">{formatSpeed(check.data.speedKmh)} km/h</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("security.dialog.lastFix")}</dt>
                <dd className="mt-0.5 text-[15px] font-semibold">
                  {check.data.fixAgeS === null ? t("security.dialog.noFix") : t("security.dialog.fixAge", { duration: formatDuration(Math.max(1, check.data.fixAgeS)) })}
                </dd>
              </div>
            </dl>
            {lock &&
              (check.data.safeNow ? (
                <Notice tone="success">{t("security.dialog.safeNow")}</Notice>
              ) : (
                <Notice tone="info">{t("security.dialog.notSafe", { speed: LOCK_MAX_SPEED_KMH, minutes: COMMAND_TTL_MIN })}</Notice>
              ))}
            <Field
              label={t("security.dialog.typeWord", { word: expected })}
              value={word}
              onChange={(e) => setWord(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
            />
          </>
        )}
        {send.isError && (
          <Notice tone="error">
            {errorText(send.error)}{" "}
            <button type="button" className="font-semibold underline underline-offset-2" onClick={() => void check.refetch()}>
              {t("security.dialog.recheck")}
            </button>
          </Notice>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant={lock ? "danger" : "primary"} loading={send.isPending} disabled={!ready}>
            {lock ? t("security.dialog.lock") : t("security.dialog.unlock")}
          </Button>
        </div>
        {check.data && <p className="text-[12.5px] leading-relaxed text-muted">{t("security.dialog.logged", { when: formatDateTime(new Date().toISOString()) })}</p>}
      </form>
    </Modal>
  );
}
