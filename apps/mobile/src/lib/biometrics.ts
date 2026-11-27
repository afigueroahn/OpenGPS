// What the phone unlocks with, and asking for it (ADR-0019). If Face ID fails,
// the phone's own passcode is offered.
import { AuthenticationType, authenticateAsync, hasHardwareAsync, isEnrolledAsync, supportedAuthenticationTypesAsync } from "expo-local-authentication";
import { useEffect, useState } from "react";

export type UnlockMethod = "Face ID" | "Touch ID";

/** Face ID or Touch ID, whichever the phone has with a face or a finger saved; null if neither. */
export async function unlockMethod(): Promise<UnlockMethod | null> {
  const [hardware, enrolled, types] = await Promise.all([hasHardwareAsync(), isEnrolledAsync(), supportedAuthenticationTypesAsync()]);
  if (!hardware || !enrolled) return null;
  if (types.includes(AuthenticationType.FACIAL_RECOGNITION)) return "Face ID";
  if (types.includes(AuthenticationType.FINGERPRINT)) return "Touch ID";
  return null;
}

/** The phone's unlock method; null while it is asked, or if there is none. */
export function useUnlockMethod(): UnlockMethod | null {
  const [method, setMethod] = useState<UnlockMethod | null>(null);
  useEffect(() => {
    let live = true;
    unlockMethod()
      .then((m) => live && setMethod(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return method;
}

/** Asks for Face ID, or the passcode if it fails; true if the person passes. */
export async function askToUnlock(texts: { prompt: string; cancel: string; passcode: string }): Promise<boolean> {
  try {
    const result = await authenticateAsync({
      promptMessage: texts.prompt,
      cancelLabel: texts.cancel,
      fallbackLabel: texts.passcode,
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
