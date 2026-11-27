// Your own corner of the panel: who you are in this account, how you see the
// platform and what you can do about your privacy.
import { type Me, USER_PHOTO_TYPES } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, DoorOpen, FileText, LogOut, Pencil, Phone, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "../../components/Avatar";
import { LanguageSwitch } from "../../components/LanguageSwitch";
import { ThemeSwitch } from "../../components/ThemeSwitch";
import { Button, Field, Spinner } from "../../components/ui";
import { ApiRequestError, auth, deletePhoto, leaveAccount, renameAccount, saveSettings, uploadPhoto } from "../../lib/api";
import i18n, { LANGUAGE_CHOICE_OPEN } from "../../lib/i18n";
import { squarePhoto } from "../../lib/image";
import { errorText } from "../widgets";
import { DeleteAccountDialog } from "../PrivacyDialogs";

function Block({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="rounded-[14px] border border-line bg-surface p-5">
      <h2 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
      {lead && <p className="mt-0.5 max-w-[60ch] text-[13.5px] leading-relaxed text-muted">{lead}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A name shown with a pencil that turns it into a field to change it. */
function EditableName({ label, value, editable, save, inline }: { label: string; value: string; editable: boolean; save: (name: string) => Promise<unknown>; inline?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(value);
  const run = useMutation({
    mutationFn: () => save(name.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      setEditing(false);
    },
  });
  if (editing) {
    return (
      <form
        className="space-y-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== value) run.mutate();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-0 flex-1 basis-56" label={label} value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} maxLength={60} autoFocus />
          <Button type="submit" loading={run.isPending} disabled={!name.trim() || name.trim() === value}>
            {t("admin.profile.name.save")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            {t("admin.profile.name.cancel")}
          </Button>
        </div>
        {run.isError && <p className="text-[13px] text-danger">{errorText(run.error)}</p>}
      </form>
    );
  }
  const start = () => {
    setName(value);
    run.reset();
    setEditing(true);
  };
  return (
    <span className={inline ? "flex min-w-0 items-center gap-1.5" : "flex min-w-0 items-center gap-2"}>
      <span className="min-w-0 truncate">{value}</span>
      {editable && (
        <button type="button" onClick={start} aria-label={t("admin.profile.name.edit", { what: label })} title={t("admin.profile.name.edit", { what: label })} className="shrink-0 rounded-md p-1 text-muted hover:bg-canvas hover:text-ink">
          <Pencil size={14} />
        </button>
      )}
    </span>
  );
}

/** The phone this person receives SMS notifications on: added, changed or taken away here. */
function PhoneBlock({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const saved = me.settings.phone;
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(saved ?? "");
  const save = useMutation({
    mutationFn: (next: string | null) => saveSettings({ phone: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      setEditing(false);
    },
  });
  const start = () => {
    setPhone(saved ?? "");
    save.reset();
    setEditing(true);
  };
  return (
    <Block title={t("admin.profile.contact.title")} lead={t("admin.profile.contact.lead")}>
      {editing ? (
        <form
          className="space-y-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(phone.trim() || null);
          }}
        >
          <div className="flex max-w-[460px] flex-wrap items-end gap-2">
            <Field className="min-w-0 flex-1 basis-56" label={t("admin.profile.contact.phone")} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="+50499887766" mono autoFocus />
            <Button type="submit" loading={save.isPending} disabled={!phone.trim() || phone.trim() === saved}>
              {t("admin.profile.contact.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              {t("admin.profile.contact.cancel")}
            </Button>
          </div>
          <p className="text-[13px] text-muted">{t("admin.profile.contact.phoneNote")}</p>
        </form>
      ) : saved ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 rounded-[10px] bg-canvas px-3.5 py-2.5">
            <Phone size={16} className="text-muted" aria-hidden="true" />
            <span className="num text-[15px] font-medium text-ink">{saved}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={start}>
            <Pencil size={14} aria-hidden="true" /> {t("admin.profile.contact.edit")}
          </Button>
          <Button variant="ghost" size="sm" loading={save.isPending} onClick={() => save.mutate(null)}>
            <Trash2 size={14} aria-hidden="true" /> {t("admin.profile.contact.remove")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[14px] text-muted">{t("admin.profile.contact.none")}</p>
          <Button variant="secondary" size="sm" onClick={start}>
            <Plus size={14} aria-hidden="true" /> {t("admin.profile.contact.add")}
          </Button>
        </div>
      )}
      {save.isError && <p className="mt-2 text-[13px] text-danger">{errorText(save.error)}</p>}
    </Block>
  );
}

/** The person's photo with a button to change it and the way to take it away, beside who they are (`children`). */
function PhotoAndName({ me, children }: { me: Me; children: ReactNode }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const done = () => queryClient.invalidateQueries({ queryKey: ["me"] });
  // The picture is cut to a small square here, so it travels light whatever the camera took.
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const photo = await squarePhoto(file);
      if (!photo) throw new ApiRequestError(0, "photo_unreadable", i18n.t("admin.profile.photo.unreadable"));
      return uploadPhoto(photo);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: deletePhoto, onSuccess: done });
  const busy = upload.isPending || remove.isPending;
  const failed = upload.error ?? remove.error;
  const pick = () => {
    upload.reset();
    remove.reset();
    input.current?.click();
  };
  return (
    <div>
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <Avatar name={me.user.name} photoUrl={me.user.photoUrl} className="h-14 w-14 text-[20px] text-ink" fill="bg-ink/[0.08]" />
          <button
            type="button"
            onClick={pick}
            disabled={busy}
            aria-label={t("admin.profile.photo.change")}
            title={t("admin.profile.photo.change")}
            className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface bg-primary text-on-primary hover:bg-primary/85 disabled:opacity-70"
          >
            {busy ? <Spinner size={13} /> : <Camera size={13} aria-hidden="true" />}
          </button>
          <input
            ref={input}
            type="file"
            accept={USER_PHOTO_TYPES.join(",")}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) upload.mutate(file);
            }}
          />
        </div>
        <div className="min-w-0 flex-1 pt-1">
          {children}
          {me.user.photoUrl && (
            <button type="button" onClick={() => remove.mutate()} disabled={busy} className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink hover:underline disabled:opacity-60">
              <Trash2 size={13} aria-hidden="true" /> {t("admin.profile.photo.remove")}
            </button>
          )}
        </div>
      </div>
      {failed && (
        <p role="alert" className="mt-2 max-w-[40ch] text-[13px] text-danger">
          {errorText(failed)}
        </p>
      )}
    </div>
  );
}

export function ProfileSection({ me }: { me: Me }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const signOut = async () => {
    await auth.signOut().catch(() => {});
    queryClient.clear();
    window.location.assign("/login");
  };
  // Whoever was invited can leave the foreign account; their own stays intact.
  const leave = async () => {
    await leaveAccount().catch(() => {});
    window.location.assign("/");
  };
  const link = "inline-flex items-center gap-2 text-[14.5px] font-medium text-ink hover:underline";

  return (
    <div className="space-y-5">
      <Block title={t("admin.profile.identity")}>
        <PhotoAndName me={me}>
          <div className="text-[17px] font-semibold text-ink">
            <EditableName label={t("admin.profile.name.person")} value={me.user.name} editable save={(name) => saveSettings({ name })} />
          </div>
          <p className="truncate text-[14px] text-muted">{me.user.email}</p>
        </PhotoAndName>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-[10px] bg-canvas px-3.5 py-2.5">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("admin.profile.account")}</dt>
            <dd className="mt-0.5 text-[14.5px] font-medium text-ink">
              {/* The account's name is changed by its owner and its administrators. */}
              <EditableName label={t("admin.profile.name.account")} value={me.account.name} editable={me.account.role === "owner" || me.account.role === "admin"} save={renameAccount} inline />
            </dd>
          </div>
          <div className="rounded-[10px] bg-canvas px-3.5 py-2.5">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{t("admin.profile.role")}</dt>
            <dd className="mt-0.5 truncate text-[14.5px] font-medium text-ink">{me.account.roleName}</dd>
          </div>
        </dl>
      </Block>

      <Block title={t("admin.profile.appearance")} lead={t("admin.profile.appearanceLead")}>
        <ThemeSwitch className="max-w-[360px]" />
      </Block>

      {LANGUAGE_CHOICE_OPEN && (
        <Block title={t("admin.profile.language")} lead={t("admin.profile.languageLead")}>
          <LanguageSwitch className="max-w-[240px]" />
        </Block>
      )}

      <PhoneBlock me={me} />

      <Block title={t("admin.profile.privacy")}>
        <ul className="space-y-2.5">
          <li>
            <a href="/terms" target="_blank" rel="noreferrer" className={link}>
              <FileText size={16} className="text-muted" aria-hidden="true" /> {t("admin.profile.terms")}
            </a>
          </li>
          <li>
            <a href="/privacy" target="_blank" rel="noreferrer" className={link}>
              <ShieldCheck size={16} className="text-muted" aria-hidden="true" /> {t("admin.profile.privacyPolicy")}
            </a>
          </li>
        </ul>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-danger/25 bg-danger/5 px-4 py-3">
          <p className="max-w-[46ch] text-[13.5px] leading-relaxed text-ink-3">{t("admin.profile.deleteLead")}</p>
          <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
            <Trash2 size={14} aria-hidden="true" /> {t("admin.profile.delete")}
          </Button>
        </div>
      </Block>

      <Block title={t("admin.profile.session")}>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden="true" /> {t("admin.user.signOut")}
          </Button>
          {me.account.role !== "owner" && (
            <Button variant="ghost" onClick={() => void leave()} title={t("admin.profile.leaveLead")}>
              <DoorOpen size={16} aria-hidden="true" /> {t("admin.profile.leave")}
            </Button>
          )}
        </div>
      </Block>

      <DeleteAccountDialog open={deleting} onClose={() => setDeleting(false)} me={me} />
    </div>
  );
}
