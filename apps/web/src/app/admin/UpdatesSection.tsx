// Updates: the version this installation runs against the latest release on
// GitHub, what it brings, and installing it (ADR-0004). Only for whoever
// administers the platform.
import type { UpdateStatus } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../../components/ui";
import { checkUpdates, installUpdate } from "../../lib/api";
import { formatDateTime, timeAgo } from "../../lib/format";
import { useConfig, useNow } from "../../lib/session";
import { UPDATES_KEY, installing, useUpdates } from "../../lib/updates";
import { Card } from "../reports/kit";
import { ConfirmDialog, errorText } from "../widgets";
import { Row } from "./SettingsTabs";

/** How long, after an install from the console, its result takes the place of "up to date". */
const JUST_INSTALLED_MS = 60 * 60_000;

/** An install from the console ended well not long ago, and its version is the one running. */
const justInstalled = (updates: UpdateStatus, now: number) => {
  const last = updates.install.last;
  return last?.state === "ok" && last.version === updates.current && now - Date.parse(last.at) < JUST_INSTALLED_MS ? last : null;
};

/** Where the install guide explains how to install a new version. */
const GUIDE = "https://github.com/afigueroahn/OpenGPS/blob/main/deploy/README.md#instalar-una-versión-nueva";

function Status({ updates }: { updates: UpdateStatus }) {
  const { t } = useTranslation();
  const now = useNow(60_000);
  // Right after updating, one message says so, instead of "up to date" as well.
  const installed = justInstalled(updates, now);
  if (installed && !updates.available) return <Notice tone="success">{t("admin.updates.install.ok", { version: installed.version, when: timeAgo(installed.at, now) })}</Notice>;
  if (!updates.repository) return <Notice>{t("admin.updates.off")}</Notice>;
  if (updates.error) return <Notice tone="error">{t(`admin.updates.error.${updates.error}`)}</Notice>;
  if (updates.available && updates.latest) {
    return (
      <Notice tone="success">
        {t("admin.updates.available", { version: updates.latest.version })}
        {updates.install.mode !== "console" && (
          <>
            {" "}
            <a href={GUIDE} target="_blank" rel="noreferrer" className="font-semibold underline">
              {t("admin.updates.howTo")}
            </a>
          </>
        )}
      </Notice>
    );
  }
  if (!updates.latest) return <Notice>{updates.checkedAt ? t("admin.updates.none") : t("admin.updates.notYet")}</Notice>;
  return <Notice tone="success">{t("admin.updates.upToDate")}</Notice>;
}

/** Installing the new version, or how to do it by hand; and how the last install ended. */
function Install({ updates }: { updates: UpdateStatus }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { install, latest, available } = updates;
  const last = install.last;

  if (last && installing(updates)) {
    const step = last.state as "preparing" | "requested" | "running";
    return (
      <Notice>
        <span className="flex items-center gap-2">
          <Spinner /> {t(`admin.updates.install.${step}`, { version: last.version })}
        </span>
      </Notice>
    );
  }
  return (
    <div className="space-y-3">
      {/* A failed install is told while that version is still the one offered. */}
      {last?.state === "failed" && last.version === latest?.version && <Notice tone="error">{t(`admin.updates.install.reasons.${last.reason ?? "broken"}`, { version: last.version, from: last.from ?? "—" })}</Notice>}
      {available && latest && install.mode === "console" && (
        <>
          <Button onClick={() => setConfirming(true)}>{t("admin.updates.install.button", { version: latest.version })}</Button>
          <ConfirmDialog
            open={confirming}
            title={t("admin.updates.install.confirmTitle", { version: latest.version })}
            confirm={t("admin.updates.install.confirm")}
            // Installing deletes nothing, and goes back by itself if it fails.
            tone="primary"
            onClose={() => setConfirming(false)}
            action={async () => queryClient.setQueryData(UPDATES_KEY, await installUpdate(latest.version))}
          >
            {t("admin.updates.install.confirmBody")}
          </ConfirmDialog>
        </>
      )}
      {available && latest && install.mode === "manual" && <Notice>{t("admin.updates.install.manual", { version: latest.version })}</Notice>}
      {available && install.mode === "source" && <Notice>{t("admin.updates.install.source")}</Notice>}
    </div>
  );
}

export function UpdatesSection() {
  const { t } = useTranslation();
  const now = useNow(60_000);
  const queryClient = useQueryClient();
  const updates = useUpdates(true, { follow: true });
  const shown = useConfig().data?.version;
  const check = useMutation({ mutationFn: checkUpdates, onSuccess: (data) => queryClient.setQueryData(UPDATES_KEY, data) });

  // Once the platform answers with another version, the page loads that version's web app.
  const running = updates.data?.current;
  useEffect(() => {
    if (shown && running && running !== shown) window.location.reload();
  }, [shown, running]);

  if (!updates.data) return updates.isError ? <Notice tone="error">{errorText(updates.error)}</Notice> : <Spinner />;
  const { current, latest, checkedAt, repository } = updates.data;

  return (
    <div className="space-y-6">
      <Card
        title={t("admin.updates.title")}
        {...(repository && { note: t("admin.updates.from", { repository, when: checkedAt ? timeAgo(checkedAt, now) : t("admin.updates.never") }) })}
        action={
          repository && (
            <Button variant="secondary" size="sm" loading={check.isPending} onClick={() => check.mutate()}>
              {t("admin.updates.checkNow")}
            </Button>
          )
        }
      >
        <div className="space-y-4 px-4 pb-4 pt-3">
          <div>
            <Row title={t("admin.updates.installed")}>
              <span className="num text-sm font-semibold">{current}</span>
            </Row>
            <Row title={t("admin.updates.latest")} {...(latest?.publishedAt && { note: formatDateTime(latest.publishedAt) })}>
              <span className="num text-sm font-semibold">{latest?.version ?? "—"}</span>
            </Row>
          </div>
          {check.isError ? <Notice tone="error">{errorText(check.error)}</Notice> : <Status updates={updates.data} />}
          <Install updates={updates.data} />
        </div>
      </Card>

      {latest && (
        <Card
          title={t("admin.updates.notes", { name: latest.name })}
          action={
            latest.url && (
              <a href={latest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline">
                {t("admin.updates.onGitHub")} <ExternalLink size={14} />
              </a>
            )
          }
        >
          <p className="whitespace-pre-wrap px-4 pb-4 pt-3 text-sm leading-relaxed text-ink-3">{latest.notes || t("admin.updates.noNotes")}</p>
        </Card>
      )}
    </div>
  );
}
