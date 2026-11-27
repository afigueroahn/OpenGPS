// The app locked with Face ID (ADR-0019): when it opens, and when it comes back
// after LOCK_AFTER_MS away, nothing of the account shows until the person
// passes Face ID or the phone's passcode, or signs out.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { askToUnlock, useUnlockMethod } from "../lib/biometrics";
import { locksOnReturn } from "../lib/lock";
import { useConfig } from "../lib/session";
import { signOut } from "../lib/signOut";
import { getSaved } from "../lib/storage";
import { AuthFrame } from "./AuthFrame";
import { Button, Notice } from "./ui";

/** Whether the app is locked now; locked from the start when Face ID is on. */
export function useAppLock(): { locked: boolean; unlock: () => void } {
  const [locked, setLocked] = useState(() => getSaved().faceId);
  const leftAt = useRef<number | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") leftAt.current = Date.now();
      else if (state === "active") {
        if (getSaved().faceId && locksOnReturn(leftAt.current, Date.now())) setLocked(true);
        leftAt.current = null;
      }
    });
    return () => subscription.remove();
  }, []);
  return { locked, unlock: () => setLocked(false) };
}

export function LockScreen(props: { onUnlock: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const method = useUnlockMethod();
  const config = useConfig();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef(false);

  const unlock = async () => {
    setBusy(true);
    const passed = await askToUnlock({ prompt: t("lock.prompt"), cancel: t("lock.cancel"), passcode: t("lock.passcode") });
    setBusy(false);
    if (passed) props.onUnlock();
    else setFailed(true);
  };

  // It asks as soon as it shows, as the phone's own apps do.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void unlock();
  });

  return (
    <AuthFrame name={config.data?.appName ?? "OpenGPS"} title={t("lock.title")} body={t("lock.body")}>
      {failed ? <Notice dark text={t("lock.failed")} testID="lock-failed" /> : null}
      <Button
        dark
        kind="signal"
        label={method ? t("lock.unlockWith", { method }) : t("lock.unlock")}
        busy={busy}
        onPress={() => void unlock()}
        testID="unlock"
      />
      <Button dark kind="secondary" label={t("account.signOut")} disabled={busy} onPress={() => void signOut(queryClient)} testID="lock-sign-out" />
    </AuthFrame>
  );
}
