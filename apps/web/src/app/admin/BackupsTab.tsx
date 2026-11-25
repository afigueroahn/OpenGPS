// Platform console: backups. Their schedule, their
// retention, on-demand backups, the list of existing ones and their restore.
import { BACKUP_MIN_GAP_MIN, BACKUP_PRESETS, BACKUP_RETENTIONS, type Backup, type BackupSettings, type PlatformSettings, type RestoreInfo, confirmWord, cronProblem, cronUpcoming, isConfirmWord, isCron, parseCron } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18n, { currentLanguage, sayShared } from "../../lib/i18n";
import clsx from "clsx";
import { Download, History, Search, Trash } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button, Modal, Notice, Spinner } from "../../components/ui";
import { ApiRequestError, backupFileUrl, deleteBackup, discoverBackups, getBackups, restoreBackup, startBackup } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { Card, inputClass, selectClass } from "../reports/kit";
import { ConfirmDialog, errorText } from "../widgets";
import { ResetButton, Row, SaveBar, Switch, useSaveSection, useSettings } from "./SettingsTabs";

/** "1,2 GB", "340 KB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(currentLanguage(), { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

const restoring = (restore: RestoreInfo | null | undefined) => restore?.state === "requested" || restore?.state === "running";

export function BackupsTab({ onStorage }: { onStorage: () => void }) {
  const { t } = useTranslation();
  const settings = useSettings();
  const backups = useQuery({
    queryKey: ["admin", "backups"],
    queryFn: getBackups,
    // While a backup or a restore is in progress, its progress is polled often.
    refetchInterval: (query) => (query.state.data?.running || restoring(query.state.data?.restore) ? 3000 : 30_000),
    retry: false,
  });
  const info = backups.data;
  // A restore changes the database: the session it was requested with may stop existing.
  const signedOut = backups.error instanceof ApiRequestError && backups.error.status === 401;
  if (signedOut) {
    return (
      <Notice>
        <Trans i18nKey="admin.backups.signedOut" components={{ login: <Link to="/login?next=%2Fadmin%2Fsystem%2Fbackups" className="font-semibold underline underline-offset-2" /> }} />
      </Notice>
    );
  }
  if (!settings.data || !info) {
    const failed = settings.error ?? backups.error;
    if (failed) return <Notice tone="error">{errorText(failed)}</Notice>;
    return (
      <div className="flex h-40 items-center justify-center text-muted">
        <Spinner size={22} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {!info.available && <Notice>{t("admin.backups.unavailable")}</Notice>}
      <RestoreBanner restore={info.restore} down={backups.isError} />
      <ScheduleForm current={settings.data.backups} storage={settings.data.storage} onStorage={onStorage} />
      <BackupList backups={info.backups} running={info.running} available={info.available} canRestore={info.canRestore} busy={restoring(info.restore)} storageOn={settings.data.storage.enabled && settings.data.storage.hasSecret} onStorage={onStorage} />
    </div>
  );
}

/** How the requested restore is going, or how the last one ended. */
function RestoreBanner({ restore, down }: { restore: RestoreInfo | null; down: boolean }) {
  const { t } = useTranslation();
  if (!restore) return null;
  const date = restore.backupAt ? formatDateTime(restore.backupAt) : null;
  if (restoring(restore)) {
    return (
      <Notice>
        <span className="inline-flex items-center gap-2 font-semibold">
          <Spinner size={15} /> {date ? t("admin.backups.banner.runningTo", { date }) : t("admin.backups.banner.running")}
        </span>
        <span className="mt-1 block">{down ? t("admin.backups.banner.down") : t("admin.backups.banner.steps")}</span>
      </Notice>
    );
  }
  const at = formatDateTime(restore.at);
  if (restore.state === "done") return <Notice tone="success">{date ? t("admin.backups.banner.doneTo", { at, date }) : t("admin.backups.banner.done", { at })}</Notice>;
  const reason = restore.error ?? t("admin.backups.noDetail");
  return <Notice tone="error">{date ? t("admin.backups.banner.failedTo", { date, reason }) : t("admin.backups.banner.failed", { reason })}</Notice>;
}

const upcomingFormat = new Intl.DateTimeFormat(currentLanguage(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function ScheduleForm({ current, storage, onStorage }: { current: BackupSettings; storage: PlatformSettings["storage"]; onStorage: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(current);
  const save = useSaveSection("backups");
  useEffect(() => setForm(current), [current]);
  const set = <K extends keyof BackupSettings>(key: K, value: BackupSettings[K]) => setForm((f) => ({ ...f, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(current);
  const retentions = [...new Set([...BACKUP_RETENTIONS, form.retentionDays])].sort((a, b) => a - b);
  const cron = form.cron.trim().replace(/\s+/g, " ");
  const problem = cronProblem(cron, BACKUP_MIN_GAP_MIN);
  const parsed = parseCron(cron);
  const upcoming = problem || !isCron(parsed) ? [] : cronUpcoming(parsed, Date.now(), 3);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem) save.mutate({ ...form, cron });
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Card title={t("admin.backups.schedule.title")} note={t("admin.backups.schedule.note")}>
        <Row title={t("admin.backups.schedule.scheduled")} note={t("admin.backups.schedule.scheduledNote")}>
          <Switch label={t("admin.backups.schedule.scheduled")} checked={form.scheduled} onChange={(on) => set("scheduled", on)} />
        </Row>
        <Row title={t("admin.backups.schedule.frequency")} note={t("admin.backups.schedule.frequencyNote")} wide>
          <div className="flex w-full flex-wrap gap-2 sm:justify-end">
            {BACKUP_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                aria-pressed={cron === preset.cron}
                onClick={() => set("cron", preset.cron)}
                className={clsx(
                  "h-9 rounded-[9px] border px-3 text-[13px] font-medium transition-colors",
                  cron === preset.cron ? "border-ink bg-surface text-ink ring-2 ring-ink/15" : "border-line bg-surface text-ink-3 hover:bg-canvas",
                )}
              >
                {t(`shared.backupPreset.${preset.id}`)}
              </button>
            ))}
          </div>
          <input
            className={clsx(inputClass, "num w-full", problem && "border-danger")}
            aria-label={t("admin.backups.schedule.cron")}
            aria-invalid={problem ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            value={form.cron}
            onChange={(e) => set("cron", e.target.value)}
          />
          {problem ? (
            <p className="text-[13px] text-danger">{sayShared(problem)}.</p>
          ) : (
            <p className="text-[13px] text-muted">
              {t(form.scheduled ? "admin.backups.schedule.upcoming" : "admin.backups.schedule.upcomingOff", { times: upcoming.map((time) => upcomingFormat.format(time)).join(" · ") })}
            </p>
          )}
          <p className="text-[12.5px] leading-relaxed text-faint">
            <Trans i18nKey="admin.backups.schedule.cronHelp" components={{ num: <span className="num" /> }} />
          </p>
        </Row>
        <Row title={t("admin.backups.schedule.retention")} note={t("admin.backups.schedule.retentionNote")}>
          <select className={selectClass} aria-label={t("admin.backups.schedule.retention")} value={form.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value))}>
            {retentions.map((d) => (
              <option key={d} value={d}>
                {t("admin.backups.schedule.days", { days: d })}
              </option>
            ))}
          </select>
        </Row>
        <Row
          title={t("admin.backups.schedule.upload")}
          note={
            storage.enabled ? (
              t("admin.backups.schedule.uploadNote", { bucket: storage.bucket })
            ) : (
              <Trans
                i18nKey="admin.backups.schedule.uploadSetup"
                components={{ storage: <button type="button" onClick={onStorage} className="font-medium text-signal-ink underline underline-offset-2" /> }}
              />
            )
          }
        >
          <Switch label={t("admin.backups.schedule.upload")} checked={form.upload} disabled={!storage.enabled && !form.upload} onChange={(on) => set("upload", on)} />
        </Row>
      </Card>
      <SaveBar dirty={dirty && !problem} saving={save.isPending} error={save.error} saved={save.isSuccess}>
        <ResetButton section="backups" what={t("admin.backups.schedule.reset")} />
      </SaveBar>
    </form>
  );
}

function where(b: Backup): string {
  if (b.local && b.remote) return i18n.t("admin.backups.where.both");
  if (b.remote) return i18n.t("admin.backups.where.remote");
  return b.local ? i18n.t("admin.backups.where.local") : i18n.t("admin.backups.where.gone");
}

function BackupList({ backups, running, available, canRestore, busy, storageOn, onStorage }: { backups: Backup[]; running: boolean; available: boolean; canRestore: boolean; busy: boolean; storageOn: boolean; onStorage: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<Backup | null>(null);
  const [restoringOne, setRestoringOne] = useState<Backup | null>(null);
  const start = useMutation({
    mutationFn: startBackup,
    onSuccess: (info) => queryClient.setQueryData(["admin", "backups"], info),
  });
  const discover = useMutation({
    mutationFn: discoverBackups,
    onSuccess: (result) => queryClient.setQueryData(["admin", "backups"], result.info),
  });
  return (
    <Card
      title={t("admin.backups.list.title")}
      note={canRestore ? t("admin.backups.list.noteRestore") : t("admin.backups.list.noteDownload")}
      action={
        <Button size="sm" loading={start.isPending || running} disabled={!available || running || busy} onClick={() => start.mutate()}>
          {running ? t("admin.backups.list.copying") : t("admin.backups.list.now")}
        </Button>
      }
    >
      {start.isError && (
        <div className="mb-3">
          <Notice tone="error">{errorText(start.error)}</Notice>
        </div>
      )}
      {backups.length === 0 ? (
        <p className="py-4 text-sm text-muted">{t("admin.backups.list.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {backups.map((b) => (
            <li key={b.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {formatDateTime(b.startedAt)}
                    <span className="ml-2 font-normal text-muted">{t(`admin.backups.kind.${b.kind}`)}</span>
                  </p>
                  <p className={clsx("mt-0.5 text-[13px]", b.status === "failed" ? "text-danger" : "text-muted")}>
                    {b.status === "running" && t("admin.backups.list.copying")}
                    {b.status === "failed" && t("admin.backups.list.failed", { reason: b.error ?? t("admin.backups.noDetail") })}
                    {b.status === "ok" && `${formatBytes(b.bytes)} · ${where(b)}`}
                  </p>
                  {b.status === "ok" && b.remoteError && <p className="mt-0.5 text-[13px] text-danger">{t("admin.backups.list.remoteFailed", { reason: b.remoteError })}</p>}
                </div>
                {b.status !== "running" && (
                  <div className="flex shrink-0 items-center gap-1">
                    {b.status === "ok" && canRestore && (b.local || b.remote) && (
                      <Button variant="secondary" size="sm" disabled={busy || running} onClick={() => setRestoringOne(b)}>
                        <History size={14} /> {t("admin.backups.restore")}
                      </Button>
                    )}
                    <button type="button" aria-label={t("admin.backups.list.delete")} title={t("admin.backups.list.deleteShort")} disabled={busy} onClick={() => setRemoving(b)} className="flex h-8 w-8 items-center justify-center rounded-[10px] text-muted hover:bg-canvas hover:text-ink disabled:opacity-40">
                      <Trash size={15} />
                    </button>
                  </div>
                )}
              </div>
              {b.status === "ok" && (b.local || b.remote) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {b.files.map((f) => (
                    <a key={f.name} href={backupFileUrl(b.id, f.name)} download={f.name} className="inline-flex items-center gap-1.5 rounded-[9px] border border-line px-2.5 py-1.5 text-[12.5px] font-medium text-ink-3 hover:bg-canvas">
                      <Download size={13} /> {t(`shared.backupPart.${f.part}`)} <span className="num font-normal text-muted">{formatBytes(f.bytes)}</span>
                    </a>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* For a new installation, or one that was restored: backups that are outside the server and the list does not know. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-3">
        <p className="min-w-0 flex-1 basis-64 text-[12.5px] text-muted">
          {storageOn ? (
            t("admin.backups.discover.prompt")
          ) : (
            <Trans i18nKey="admin.backups.discover.setup" components={{ storage: <button type="button" onClick={onStorage} className="font-medium text-signal-ink underline underline-offset-2" /> }} />
          )}
        </p>
        <Button type="button" variant="secondary" size="sm" loading={discover.isPending} disabled={!storageOn || busy} onClick={() => discover.mutate()}>
          <Search size={14} /> {t("admin.backups.discover.search")}
        </Button>
      </div>
      {discover.isError && (
        <div className="mt-3">
          <Notice tone="error">{errorText(discover.error)}</Notice>
        </div>
      )}
      {discover.isSuccess && (
        <p className="mt-2 text-[12.5px] text-muted" role="status">
          {discover.data.found === 0
            ? t("admin.backups.discover.none")
            : discover.data.added === 0
              ? t("admin.backups.discover.known", { count: discover.data.found })
              : discover.data.found > discover.data.added
                ? t("admin.backups.discover.addedSome", { count: discover.data.added })
                : t("admin.backups.discover.added", { count: discover.data.added })}
        </p>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t("admin.backups.remove.title")}
        confirm={t("admin.backups.remove.confirm")}
        onClose={() => setRemoving(null)}
        action={() => deleteBackup((removing as Backup).id)}
        onDone={() => void queryClient.invalidateQueries({ queryKey: ["admin", "backups"] })}
      >
        {t(removing?.remote ? "admin.backups.remove.bodyRemote" : "admin.backups.remove.body", { date: removing ? formatDateTime(removing.startedAt) : "" })}
      </ConfirmDialog>
      {restoringOne && <RestoreDialog backup={restoringOne} onClose={() => setRestoringOne(null)} />}
    </Card>
  );
}

/** Restoring is the most delicate thing in the console: what happens is explained and the word must be typed. */
function RestoreDialog({ backup, onClose }: { backup: Backup; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [word, setWord] = useState("");
  const run = useMutation({
    mutationFn: () => restoreBackup(backup.id, word.trim().toUpperCase()),
    onSuccess: (info) => {
      queryClient.setQueryData(["admin", "backups"], info);
      onClose();
    },
  });
  const ready = isConfirmWord("restore", word);
  return (
    <Modal open onClose={onClose} title={t("admin.backups.restoreDialog.title")} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) run.mutate();
        }}
        className="space-y-4"
      >
        <p className="text-[15px] leading-relaxed text-ink-3">
          <Trans i18nKey="admin.backups.restoreDialog.lead" values={{ date: formatDateTime(backup.startedAt) }} components={{ strong: <strong className="text-ink" /> }} />
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-3">
          <li>
            <Trans i18nKey="admin.backups.restoreDialog.lose" components={{ strong: <strong className="text-ink" /> }} />
          </li>
          <li>{t("admin.backups.restoreDialog.undo")}</li>
          <li>{t("admin.backups.restoreDialog.stop")}</li>
          <li>{t("admin.backups.restoreDialog.passwords")}</li>
        </ul>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink-3">
            <Trans i18nKey="admin.backups.restoreDialog.type" values={{ word: confirmWord("restore", currentLanguage()) }} components={{ word: <span className="num text-ink" /> }} />
          </span>
          <input className={clsx(inputClass, "num w-full")} autoFocus autoComplete="off" value={word} onChange={(e) => setWord(e.target.value)} />
        </label>
        {run.isError && <Notice tone="error">{errorText(run.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" loading={run.isPending} disabled={!ready}>
            {t("admin.backups.restore")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
