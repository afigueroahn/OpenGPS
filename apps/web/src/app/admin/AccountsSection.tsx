// Every account of the platform, with its status, quotas and modules. Only
// those who administer the platform see it.
import { ALL_MODULES, type AdminAccount, type AdminAccountDetail, type AdminUser, type ModuleKey, type PlatformStats, confirmWord, isConfirmWord } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Search, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SignInMethodIcon } from "../../components/BrandMark";
import { Button, Modal, Notice, Spinner } from "../../components/ui";
import { ApiRequestError, banUser, deleteAdminAccount, deleteAdminUser, getAdminAccount, getAdminAccounts, getAdminStats, updateAdminAccount } from "../../lib/api";
import { formatDateTime, timeAgo } from "../../lib/format";
import i18n, { currentLanguage } from "../../lib/i18n";

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : i18n.t("admin.accounts.failed"));
const number = new Intl.NumberFormat(currentLanguage());

/** `meId`: whoever is looking, so they cannot suspend themselves. */
export function AccountsSection({ meId }: { meId: string }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  // The search fires when typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: getAdminStats, refetchInterval: 30_000 });
  const accounts = useQuery({ queryKey: ["admin", "accounts", term], queryFn: () => getAdminAccounts(term) });

  return (
    <div className="space-y-6">
      <Stats stats={stats.data} />

      <section className="rounded-[14px] border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-[17px] font-semibold tracking-tight">{t("admin.accounts.title")}</h2>
          <label className="flex h-10 w-full items-center gap-2 rounded-[10px] border border-line px-3 text-muted focus-within:border-ink sm:w-80">
            <Search size={15} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("admin.accounts.searchPlaceholder")}
              aria-label={t("admin.accounts.searchLabel")}
              className="h-full w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
            />
          </label>
        </div>

        {accounts.isLoading && (
          <div className="flex h-32 items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {accounts.isError && (
          <div className="p-4">
            <Notice tone="error">{errorText(accounts.error)}</Notice>
          </div>
        )}
        {accounts.data && accounts.data.length === 0 && <p className="p-5 text-sm text-muted">{t("admin.accounts.empty")}</p>}
        {accounts.data && accounts.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2.5 font-medium">{t("admin.accounts.columns.account")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("admin.accounts.columns.users")}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t("admin.accounts.columns.vehicles")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("admin.accounts.columns.lastSeen")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("admin.accounts.columns.lastAccess")}</th>
                  <th className="px-3 py-2.5 font-medium">{t("admin.accounts.columns.created")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("admin.accounts.columns.status")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line border-t border-line">
                {accounts.data.map((a) => (
                  <AccountRow key={a.id} account={a} onOpen={() => setOpenId(a.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AccountDialog id={openId} onClose={() => setOpenId(null)} meId={meId} />
    </div>
  );
}

/** The platform's numbers right now. */
export function Stats({ stats }: { stats: PlatformStats | undefined }) {
  const { t } = useTranslation();
  const tiles: { label: string; value: string; note?: string }[] = stats
    ? [
        { label: t("admin.accounts.stats.accounts"), value: number.format(stats.accounts), ...(stats.suspendedAccounts ? { note: t("admin.accounts.stats.suspended", { count: stats.suspendedAccounts }) } : {}) },
        { label: t("admin.accounts.stats.users"), value: number.format(stats.users) },
        { label: t("admin.accounts.stats.vehicles"), value: number.format(stats.vehicles) },
        { label: t("admin.accounts.stats.devices"), value: number.format(stats.activeDevices), ...(stats.pendingDevices ? { note: t("admin.accounts.stats.pending", { n: stats.pendingDevices }) } : {}) },
        { label: t("admin.accounts.stats.reporting"), value: number.format(stats.reportingNow), note: t("admin.accounts.stats.reportingNote") },
        { label: t("admin.accounts.stats.positions"), value: number.format(stats.positionsToday) },
        { label: t("admin.accounts.stats.disk"), value: stats.diskUsedPercent === null ? "—" : `${stats.diskUsedPercent} %` },
      ]
    : [];
  return (
    <section aria-label={t("admin.accounts.stats.label")} className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {(stats ? tiles : Array.from({ length: 7 }, () => null)).map((t, i) => (
        <div key={i} className="rounded-[12px] border border-line bg-surface px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{t?.label ?? " "}</p>
          <p className="num mt-1 text-[22px] font-semibold leading-none tracking-tight">{t?.value ?? " "}</p>
          <p className="mt-1 h-4 text-[12px] text-muted">{t?.note}</p>
        </div>
      ))}
    </section>
  );
}

function StatusPill({ suspended }: { suspended: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={clsx("inline-flex rounded-full px-2 py-0.5 text-[12px] font-medium", suspended ? "bg-danger/10 text-danger" : "bg-moving/10 text-signal-ink")}>
      {suspended ? t("admin.accounts.status.suspended") : t("admin.accounts.status.active")}
    </span>
  );
}

function AccountRow({ account: a, onOpen }: { account: AdminAccount; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <tr className="cursor-pointer hover:bg-canvas" onClick={onOpen}>
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} className="text-left">
          <span className="block font-medium">{a.name}</span>
          <span className="flex items-center gap-1.5 text-[13px] text-muted">
            {a.ownerEmail && <SignInMethodIcon method={a.ownerSignInMethod} size={14} />}
            <span className="truncate">{a.ownerEmail ?? t("admin.accounts.noOwner")}</span>
          </span>
        </button>
      </td>
      <td className="num px-3 py-3 text-right">{a.users}</td>
      <td className="num px-3 py-3 text-right">
        {a.vehicles}
        {a.limits.maxVehicles !== null && <span className="text-muted"> / {a.limits.maxVehicles}</span>}
      </td>
      <td className="px-3 py-3 text-ink-3">{a.lastSeenAt ? timeAgo(a.lastSeenAt) : "—"}</td>
      <td className="px-3 py-3 text-ink-3" title={a.ownerLastAccessAt ? formatDateTime(a.ownerLastAccessAt) : undefined}>
        {a.ownerLastAccessAt ? timeAgo(a.ownerLastAccessAt) : "—"}
      </td>
      <td className="px-3 py-3 text-ink-3">{formatDateTime(a.createdAt)}</td>
      <td className="px-4 py-3">
        <StatusPill suspended={a.suspended} />
      </td>
    </tr>
  );
}

function AccountDialog({ id, onClose, meId }: { id: string | null; onClose: () => void; meId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["admin", "account", id], queryFn: () => getAdminAccount(id as string), enabled: id !== null });
  const account = detail.data;
  const [error, setError] = useState<string | null>(null);
  // What is about to be deleted: the account, or one of its people.
  const [deleting, setDeleting] = useState<"account" | AdminUser | null>(null);
  useEffect(() => {
    setError(null);
    setDeleting(null);
  }, [id]);

  const refresh = (updated?: AdminAccountDetail) => {
    if (updated) queryClient.setQueryData(["admin", "account", id], updated);
    else void queryClient.invalidateQueries({ queryKey: ["admin", "account", id] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "stats"] });
  };
  const run = useMutation({
    mutationFn: (action: () => Promise<AdminAccountDetail | null>) => action(),
    onSuccess: (updated) => {
      setError(null);
      refresh(updated ?? undefined);
    },
    onError: (err) => setError(errorText(err)),
  });

  return (
    <Modal open={id !== null} onClose={onClose} title={account?.name ?? t("admin.accounts.dialog.title")} wide>
      {detail.isLoading && (
        <div className="flex h-32 items-center justify-center text-muted">
          <Spinner />
        </div>
      )}
      {detail.isError && <Notice tone="error">{errorText(detail.error)}</Notice>}
      {account && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-3">
            <StatusPill suspended={account.suspended} />
            <span>
              {t("admin.accounts.dialog.users", { count: account.users })} · {t("admin.accounts.dialog.vehicles", { count: account.vehicles })} · {t("admin.accounts.dialog.devices", { count: account.activeDevices })}
            </span>
            <span>{t("admin.accounts.dialog.created", { date: formatDateTime(account.createdAt) })}</span>
          </div>

          <Suspension account={account} busy={run.isPending} onRun={(patch) => run.mutate(() => updateAdminAccount(account.id, patch))} />
          <Limits account={account} busy={run.isPending} onRun={(patch) => run.mutate(() => updateAdminAccount(account.id, patch))} />
          <Modules account={account} busy={run.isPending} onRun={(modules) => run.mutate(() => updateAdminAccount(account.id, { modules }))} />

          <section>
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted">{t("admin.accounts.dialog.members")}</h3>
            <ul className="divide-y divide-line rounded-[12px] border border-line">
              {account.members.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {m.name}
                      {m.banned && <span className="ml-1.5 rounded-full bg-danger/10 px-2 py-0.5 text-[12px] font-medium text-danger">{t("admin.accounts.dialog.userSuspended")}</span>}
                    </span>
                    <span className="flex items-center gap-1.5 text-[13px] text-muted">
                      <SignInMethodIcon method={m.signInMethod} size={14} />
                      <span className="truncate">{m.email}</span>
                    </span>
                    <span className="block text-[12.5px] text-faint" title={m.lastAccessAt ? formatDateTime(m.lastAccessAt) : undefined}>
                      {m.lastAccessAt ? t("admin.accounts.dialog.lastAccess", { when: timeAgo(m.lastAccessAt) }) : t("admin.accounts.dialog.neverAccessed")}
                    </span>
                  </span>
                  {m.platformOwner ? (
                    <span className="shrink-0 rounded-full bg-ink/[0.07] px-2 py-0.5 text-[12px] font-medium text-ink-3">{t("admin.accounts.dialog.platformOwner")}</span>
                  ) : (
                    m.id !== meId && (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Button variant={m.banned ? "secondary" : "danger"} size="sm" disabled={run.isPending} onClick={() => run.mutate(() => banUser(m.id, !m.banned).then(() => null))}>
                          {m.banned ? t("admin.accounts.dialog.reactivateUser") : t("admin.accounts.dialog.suspendUser")}
                        </Button>
                        <button
                          type="button"
                          onClick={() => setDeleting(m)}
                          aria-label={t("admin.accounts.dialog.deleteUser", { name: m.name })}
                          title={t("admin.accounts.dialog.deleteUser", { name: m.name })}
                          className="rounded-lg p-2 text-muted hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    )
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[13px] text-muted">{t("admin.accounts.dialog.suspendUserNote")}</p>
          </section>

          <section className="rounded-[14px] border border-danger/25 p-4">
            <h3 className="text-[15px] font-semibold">{t("admin.accounts.delete.title")}</h3>
            <p className="mt-1 text-sm text-muted">{t(account.ownedByPlatformOwner ? "admin.accounts.delete.ownerNote" : "admin.accounts.delete.note")}</p>
            {!account.ownedByPlatformOwner && (
              <Button className="mt-3" variant="danger" size="sm" onClick={() => setDeleting("account")}>
                <Trash2 size={15} aria-hidden="true" /> {t("admin.accounts.delete.action")}
              </Button>
            )}
          </section>

          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
      {account && deleting && (
        <DeleteConfirm
          title={deleting === "account" ? t("admin.accounts.delete.confirmTitle", { name: account.name }) : t("admin.accounts.dialog.deleteUserTitle", { name: deleting.name })}
          body={deleting === "account" ? t("admin.accounts.delete.note") : t("admin.accounts.dialog.deleteUserBody", { email: deleting.email })}
          onClose={() => setDeleting(null)}
          action={(word) => (deleting === "account" ? deleteAdminAccount(account.id, word) : deleteAdminUser(deleting.id, word))}
          onDone={() => {
            // An account deleted, or a person who owned this one, takes the account with them.
            const gone = deleting === "account" || deleting.role === "owner";
            setDeleting(null);
            if (gone) {
              void queryClient.invalidateQueries({ queryKey: ["admin", "accounts"] });
              void queryClient.invalidateQueries({ queryKey: ["admin", "stats"] });
              onClose();
            } else refresh();
          }}
        />
      )}
    </Modal>
  );
}

/** Asks to type a word before deleting for good. */
function DeleteConfirm(props: { title: string; body: string; onClose: () => void; action: (word: string) => Promise<unknown>; onDone: () => void }) {
  const { t } = useTranslation();
  const [word, setWord] = useState("");
  const expected = confirmWord("deleteAccount", currentLanguage());
  const run = useMutation({ mutationFn: () => props.action(word.trim()), onSuccess: props.onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isConfirmWord("deleteAccount", word)) run.mutate();
  };
  return (
    <Modal open onClose={props.onClose} title={props.title}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-[15px] leading-relaxed text-ink-3">{props.body}</p>
        <label className="block text-[13px] font-medium text-ink-3">
          {t("admin.accounts.delete.word", { word: expected })}
          <input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            autoComplete="off"
            autoFocus
            className="mt-1.5 h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-sm focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
          />
        </label>
        {run.isError && <Notice tone="error">{errorText(run.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" loading={run.isPending} disabled={!isConfirmWord("deleteAccount", word)}>
            {t("admin.accounts.delete.confirm")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type Patch = Parameters<typeof updateAdminAccount>[1];

function Suspension({ account, busy, onRun }: { account: AdminAccountDetail; busy: boolean; onRun: (patch: Patch) => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  if (account.suspended) {
    return (
      <section className="rounded-[14px] border border-danger/25 bg-danger/5 p-4">
        <p className="text-[15px] font-semibold text-danger">{t("admin.accounts.suspension.suspended")}</p>
        <p className="mt-1 text-sm text-ink-3">{account.suspendedReason ? t("admin.accounts.suspension.reason", { reason: account.suspendedReason }) : t("admin.accounts.suspension.noReason")}</p>
        <Button className="mt-3" variant="secondary" size="sm" disabled={busy} onClick={() => onRun({ suspended: false })}>
          {t("admin.accounts.suspension.reactivate")}
        </Button>
      </section>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onRun({ suspended: true, suspendedReason: reason });
    setReason("");
  };
  return (
    <form onSubmit={submit} className="rounded-[14px] bg-canvas p-4">
      <h3 className="text-[15px] font-semibold">{t("admin.accounts.suspension.title")}</h3>
      <p className="mt-1 text-sm text-muted">{t("admin.accounts.suspension.note")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          placeholder={t("admin.accounts.suspension.reasonPlaceholder")}
          aria-label={t("admin.accounts.suspension.reasonLabel")}
          className="h-10 min-w-0 flex-1 basis-56 rounded-[10px] border border-line bg-surface px-3 text-sm placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
        />
        <Button type="submit" variant="danger" disabled={busy}>
          {t("admin.accounts.suspension.submit")}
        </Button>
      </div>
    </form>
  );
}

function Limits({ account, busy, onRun }: { account: AdminAccountDetail; busy: boolean; onRun: (patch: Patch) => void }) {
  const { t } = useTranslation();
  const [vehicles, setVehicles] = useState("");
  const [users, setUsers] = useState("");
  useEffect(() => {
    setVehicles(account.limits.maxVehicles === null ? "" : String(account.limits.maxVehicles));
    setUsers(account.limits.maxUsers === null ? "" : String(account.limits.maxUsers));
  }, [account.limits.maxVehicles, account.limits.maxUsers]);

  const parse = (v: string) => (v.trim() === "" ? null : Number(v));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onRun({ maxVehicles: parse(vehicles), maxUsers: parse(users) });
  };
  const input =
    "num h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-sm placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10";
  return (
    <form onSubmit={submit}>
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted">{t("admin.accounts.limits.title")}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-40 text-[13px] font-medium text-ink-3">
          {t("admin.accounts.limits.vehicles")}
          <input className={clsx(input, "mt-1.5")} inputMode="numeric" value={vehicles} onChange={(e) => setVehicles(e.target.value.replace(/\D/g, ""))} placeholder={t("admin.accounts.limits.none")} />
        </label>
        <label className="min-w-0 flex-1 basis-40 text-[13px] font-medium text-ink-3">
          {t("admin.accounts.limits.users")}
          <input className={clsx(input, "mt-1.5")} inputMode="numeric" value={users} onChange={(e) => setUsers(e.target.value.replace(/\D/g, ""))} placeholder={t("admin.accounts.limits.none")} />
        </label>
        <Button type="submit" variant="secondary" disabled={busy}>
          {t("admin.accounts.limits.save")}
        </Button>
      </div>
      <p className="mt-2 text-[13px] text-muted">{t("admin.accounts.limits.note")}</p>
    </form>
  );
}

function Modules({ account, busy, onRun }: { account: AdminAccountDetail; busy: boolean; onRun: (modules: ModuleKey[]) => void }) {
  const { t } = useTranslation();
  const toggle = (key: ModuleKey, on: boolean) => onRun(on ? [...account.modules, key] : account.modules.filter((m) => m !== key));
  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted">{t("admin.accounts.modules.title")}</h3>
      <div className="grid gap-1.5 text-sm sm:grid-cols-2">
        {ALL_MODULES.map((key) => (
          <label key={key} className="flex items-center gap-2">
            <input type="checkbox" checked={account.modules.includes(key)} disabled={busy} onChange={(e) => toggle(key, e.target.checked)} />
            <span>
              <span className="num text-muted">{key}</span> · {t(`shared.module.${key}`)}
            </span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-[13px] text-muted">{t("admin.accounts.modules.note")}</p>
    </section>
  );
}
