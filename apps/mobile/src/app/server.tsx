// First screen: which platform the app talks to. Each installation is its
// own, so the person types the address they open on the web.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthFrame } from "../components/AuthFrame";
import { Button, Field, Notice } from "../components/ui";
import { normalizeServer } from "../lib/address";
import { ApiRequestError, getConfig } from "../lib/api";
import { save } from "../lib/storage";
import { useTyped } from "../lib/typed";

/** Contract version this app speaks (docs/API.md). */
const API_VERSION = 3;
/** The project's own platform: the address comes written, and whoever has another one changes it. */
const OFFICIAL_SERVER = "app.opengps.dev";

export default function ServerScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const typed = useTyped(OFFICIAL_SERVER);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const base = normalizeServer(typed.latest());
    if (!base) {
      setError(t("server.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const config = await getConfig(base);
      if (typeof config?.apiVersion !== "number") setError(t("server.notPlatform"));
      else if (config.apiVersion !== API_VERSION) setError(t("server.incompatible"));
      else {
        queryClient.clear();
        queryClient.setQueryData(["config"], config);
        save({ server: base, cookie: "" });
      }
    } catch (err) {
      setError(err instanceof ApiRequestError && err.status !== 0 ? t("server.notPlatform") : t("server.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame headline={t("server.headline")} title={t("server.title")} body={t("server.body")}>
      <Field
        dark
        testID="server-address"
        label={t("server.label")}
        placeholder={t("server.placeholder")}
        defaultValue={OFFICIAL_SERVER}
        onChangeText={typed.change}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      {error ? <Notice dark text={error} testID="server-error" /> : null}
      <Button kind="signal" label={t("server.submit")} busy={busy} onPress={() => void submit()} testID="server-submit" />
    </AuthFrame>
  );
}
