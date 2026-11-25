// Updates: the version this installation runs against the latest release on
// GitHub, and what it brings. Only for whoever administers the platform.
import type { UpdateStatus } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../../components/ui";
import { checkUpdates } from "../../lib/api";
import { formatDateTime, timeAgo } from "../../lib/format";
import { useNow } from "../../lib/session";
import { UPDATES_KEY, useUpdates } from "../../lib/updates";
import { Card } from "../reports/kit";
import { errorText } from "../widgets";
import { Row } from "./SettingsTabs";

/** Where the install guide explains how to install a new version. */
const GUIDE = "https://github.com/afigueroahn/OpenGPS/blob/main/deploy/README.md#instalar-una-versión-nueva";

function Status({ updates }: { updates: UpdateStatus }) {
  const { t } = useTranslation();
  if (!updates.repository) return <Notice>{t("admin.updates.off")}</Notice>;
  if (updates.error) return <Notice tone="error">{t(`admin.updates.error.${updates.error}`)}</Notice>;
  if (updates.available && updates.latest) {
    return (
      <Notice tone="success">
        {t("admin.updates.available", { version: updates.latest.version })}{" "}
        <a href={GUIDE} target="_blank" rel="noreferrer" className="font-semibold underline">
          {t("admin.updates.howTo")}
        </a>
      </Notice>
    );
  }
  if (!updates.latest) return <Notice>{updates.checkedAt ? t("admin.updates.none") : t("admin.updates.notYet")}</Notice>;
  return <Notice tone="success">{t("admin.updates.upToDate")}</Notice>;
}

export function UpdatesSection() {
  const { t } = useTranslation();
  const now = useNow(60_000);
  const queryClient = useQueryClient();
  const updates = useUpdates(true);
  const check = useMutation({ mutationFn: checkUpdates, onSuccess: (data) => queryClient.setQueryData(UPDATES_KEY, data) });

  if (updates.isError) return <Notice tone="error">{errorText(updates.error)}</Notice>;
  if (!updates.data) return <Spinner />;
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
