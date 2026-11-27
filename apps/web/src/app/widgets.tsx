// Small pieces of the main screen.
import type { Me } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeftRight, CircleArrowUp, LogOut, Settings2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Avatar } from "../components/Avatar";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { Button, Logo, Modal, Notice, Spinner } from "../components/ui";
import { ApiRequestError, auth, setActiveAccount } from "../lib/api";
import i18n, { adoptLanguage } from "../lib/i18n";
import type { LiveStatus } from "../lib/live";
import { useConfig } from "../lib/session";
import { adoptMode } from "../lib/theme";
import { useNewVersion } from "../lib/updates";

export const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : i18n.t("map.errors.action"));

/** Returns `value`, but without changing more than once every `ms`. */
export function useThrottled<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setCurrent(value);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setCurrent(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

/** Cellular signal in four bars. */
export function SignalBars({ bars }: { bars: number }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-end gap-[3px]" role="img" aria-label={t("map.detail.signalBars", { bars })}>
      {[1, 2, 3, 4].map((n) => (
        <span key={n} className={clsx("w-[4px] rounded-[1px]", n <= bars ? "bg-signal" : "bg-white/20")} style={{ height: 3 + n * 3 }} />
      ))}
    </span>
  );
}

export function LiveBadge({ status }: { status: LiveStatus }) {
  const { t } = useTranslation();
  const online = status === "online";
  return (
    <span
      className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium", online ? "bg-signal/15 text-signal" : "bg-white/10 text-white/60")}
      title={online ? t("map.live.onlineNote") : t("map.live.offlineNote")}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", online ? "bg-signal" : "bg-white/50")} />
      {online ? t("map.live.online") : t("map.live.offline")}
    </span>
  );
}

export function AccountMenu({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { name, email } = me.user;
  const version = useConfig().data?.version;
  // Only the platform's owner is told of a newer version.
  const newVersion = useNewVersion(me.user.platformAdmin);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const signOut = async () => {
    await auth.signOut().catch(() => {});
    queryClient.clear();
    window.location.assign("/login");
  };
  // Switching accounts changes everything shown: it reloads from the start.
  const switchTo = async (accountId: string) => {
    await setActiveAccount(accountId).catch(() => {});
    window.location.assign("/");
  };
  // The color mode saved with the account applies on a device that has not chosen one.
  useEffect(() => adoptMode(me.settings.theme), [me.settings.theme]);
  // The language saved with the person follows them to this browser.
  useEffect(() => void adoptLanguage(me.settings.language), [me.settings.language]);
  const item = "flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-sm font-medium hover:bg-canvas";
  const others = me.accounts.filter((a) => a.id !== me.account.id);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("map.account.menu")}
        className="group flex h-8 w-8 items-center justify-center overflow-hidden rounded-full text-[12px]"
      >
        <Avatar name={name} photoUrl={me.user.photoUrl} className="h-full w-full" fill="bg-ink-3 group-hover:bg-white/20" />
      </button>
      {newVersion && <span aria-hidden className="pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-moving" />}
      {open && (
        <div role="menu" className="themed absolute right-0 top-10 z-20 w-72 rounded-[14px] bg-surface p-1.5 text-ink shadow-2xl ring-1 ring-ink/10">
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-[13px] text-muted">{email}</p>
          </div>
          <div className="mx-1.5 mb-1 rounded-[10px] bg-canvas px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("map.account.account")}</p>
            <p className="truncate text-sm font-medium">{me.account.name}</p>
            <p className="text-[13px] text-muted">{me.account.roleName}</p>
          </div>
          <ThemeSwitch className="mx-1.5 mb-1" />
          {others.map((a) => (
            <button key={a.id} type="button" role="menuitem" onClick={() => void switchTo(a.id)} className={item}>
              <ArrowLeftRight size={16} /> <span className="truncate">{t("map.account.switchTo", { name: a.name })}</span>
            </button>
          ))}
          {newVersion && (
            <Link role="menuitem" to="/admin/system/updates" className={clsx(item, "text-moving")}>
              <CircleArrowUp size={16} /> {t("common.newVersion", { version: newVersion })}
            </Link>
          )}
          <Link role="menuitem" to="/admin" className={item}>
            <Settings2 size={16} /> {t("admin.title")}
          </Link>
          <button type="button" role="menuitem" onClick={signOut} className={item}>
            <LogOut size={16} /> {t("map.account.signOut")}
          </button>
          {version && <p className="num mt-1 border-t border-line px-3 pb-1 pt-2 text-[12px] text-faint">{t("common.version", { version })}</p>}
        </div>
      )}
    </div>
  );
}

/** What someone sees when entering an account the platform suspended. */
export function SuspendedScreen({ me }: { me: Me }) {
  const { t } = useTranslation();
  const others = me.accounts.filter((a) => a.id !== me.account.id);
  const signOut = async () => {
    await auth.signOut().catch(() => {});
    window.location.assign("/login");
  };
  const switchTo = async (accountId: string) => {
    await setActiveAccount(accountId).catch(() => {});
    window.location.assign("/");
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo />
      <div className="max-w-md">
        <h1 className="text-[22px] font-semibold tracking-tight">{t("map.suspended.title")}</h1>
        <p className="mt-2 text-[15px] text-ink-3">
          <Trans i18nKey="map.suspended.body" values={{ name: me.account.name }} components={{ b: <strong className="font-semibold text-ink" /> }} />
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {others.map((a) => (
          <Button key={a.id} variant="secondary" onClick={() => void switchTo(a.id)}>
            {t("map.suspended.goTo", { name: a.name })}
          </Button>
        ))}
        {me.user.platformAdmin && (
          <a href="/admin">
            <Button variant="secondary">{t("map.suspended.admin")}</Button>
          </a>
        )}
        <Button onClick={signOut}>{t("map.account.signOut")}</Button>
      </div>
    </div>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  confirm: string;
  children: ReactNode;
  onClose: () => void;
  action: () => Promise<unknown>;
  onDone?: () => void;
  /** The confirm button's color: red for what deletes or cannot be undone (the default), the main one otherwise. */
  tone?: "danger" | "primary";
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: props.action,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      await queryClient.invalidateQueries({ queryKey: ["groups"] });
      props.onClose();
      props.onDone?.();
    },
  });
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.title}>
      <div className="space-y-5">
        <p className="text-[15px] leading-relaxed text-ink-3">{props.children}</p>
        {run.isError && <Notice tone="error">{errorText(run.error)}</Notice>}
        <div className="flex justify-end gap-2">
          {/* With its type: inside a form, a button without a type submits it. */}
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant={props.tone ?? "danger"} loading={run.isPending} onClick={() => run.mutate()}>
            {props.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function FullScreenSpinner() {
  return (
    <div className="flex h-full items-center justify-center bg-panel text-white/60">
      <Spinner size={26} />
    </div>
  );
}

export function FullScreenError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <Logo />
      <p className="max-w-sm text-[15px] text-ink-3">{t("map.errors.server")}</p>
      <Button onClick={onRetry}>{t("common.retry")}</Button>
    </div>
  );
}
