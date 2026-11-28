// Share a vehicle's location with someone outside: create a temporary
// link, copy it and revoke the ones still alive.
import { SHARE_DURATIONS, type ShareLink, type Vehicle } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, CopyText, Field, Modal, Notice, Spinner } from "../components/ui";
import { createShare, getShares, revokeShare, shareUrl } from "../lib/api";
import i18n from "../lib/i18n";
import { formatDateTime, formatDuration } from "../lib/format";
import { ConfirmBar, errorText } from "./widgets";

/** "8 hours", "3 days": whole days are said in days. */
const durationLabel = (hours: number) => (hours % 24 === 0 ? i18n.t("map.share.days", { count: hours / 24 }) : i18n.t("map.share.hours", { count: hours }));

export function ShareDialog({ open, onClose, vehicle }: { open: boolean; onClose: () => void; vehicle: Vehicle }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [hours, setHours] = useState<number>(8);
  const [note, setNote] = useState("");
  /** Address of the newly created link: it can only be copied now. */
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  /** The link being asked about before revoking it. */
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setFresh(null);
      setAsking(null);
      setNote("");
      setHours(8);
    }
  }, [open]);

  const links = useQuery({ queryKey: ["shares", vehicle.id], queryFn: () => getShares(vehicle.id), enabled: open });
  const create = useMutation({
    mutationFn: () => createShare(vehicle.id, { hours, note: note.trim() }),
    onSuccess: async ({ link, token }) => {
      setFresh({ id: link.id, url: shareUrl(token) });
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["shares", vehicle.id] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeShare(id),
    onSuccess: (_, id) => {
      // If the newly created link is revoked, its address is no longer valid: it stops being shown.
      setFresh((f) => (f?.id === id ? null : f));
      setAsking(null);
      return queryClient.invalidateQueries({ queryKey: ["shares", vehicle.id] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const canShareNatively = typeof navigator.share === "function";

  return (
    <Modal open={open} onClose={onClose} title={t("map.share.title")}>
      <div className="space-y-5">
        <p className="text-[15px] leading-relaxed text-ink-3">
          <Trans i18nKey="map.share.intro" values={{ name: vehicle.name }} components={{ b: <strong className="font-semibold text-ink" /> }} />
        </p>

        {fresh ? (
          <div className="space-y-3">
            <Notice tone="success">{t("map.share.created")}</Notice>
            <CopyText value={fresh.url} label={t("map.share.link")} />
            <div className="flex flex-wrap gap-2">
              {canShareNatively && (
                <Button variant="secondary" size="sm" onClick={() => void navigator.share({ title: t("map.share.shareTitle", { name: vehicle.name }), url: fresh.url }).catch(() => {})}>
                  <Share2 size={15} /> {t("map.share.send")}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>
                {t("map.share.another")}
              </Button>
            </div>
            <p className="text-[13px] leading-relaxed text-muted">{t("map.share.warning")}</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="duracion-del-enlace" className="mb-1.5 block text-[13px] font-medium text-ink-3">
                {t("map.share.duration")}
              </label>
              <select
                id="duracion-del-enlace"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className="h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[15px] text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
              >
                {SHARE_DURATIONS.map((h) => (
                  <option key={h} value={h}>
                    {durationLabel(h)}
                  </option>
                ))}
              </select>
            </div>
            <Field label={t("map.share.note")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} hint={t("map.share.noteHint")} />
            {create.isError && <Notice tone="error">{errorText(create.error)}</Notice>}
            <Button type="submit" loading={create.isPending} full>
              {t("map.share.create")}
            </Button>
          </form>
        )}

        <section>
          <h3 className="mb-2 text-[13px] font-medium text-ink-3">{t("map.share.alive")}</h3>
          {links.isLoading && (
            <div className="flex h-16 items-center justify-center text-muted">
              <Spinner />
            </div>
          )}
          {links.isError && <Notice tone="error">{errorText(links.error)}</Notice>}
          {links.isSuccess && links.data.length === 0 && <p className="text-sm text-muted">{t("map.share.none")}</p>}
          <ul className="divide-y divide-line">
            {links.data?.map((link) =>
              asking === link.id ? (
                <li key={link.id} className="py-2.5">
                  <ConfirmBar confirm={t("map.share.revoke")} pending={revoke.isPending} onCancel={() => setAsking(null)} onConfirm={() => revoke.mutate(link.id)}>
                    {t("map.share.confirmRevoke", { vehicle: vehicle.name })}
                  </ConfirmBar>
                </li>
              ) : (
                <li key={link.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{link.note || t("map.share.noNote")}</p>
                    <p className="text-[13px] text-muted">{detailOf(link)}</p>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => setAsking(link.id)}>
                    {t("map.share.revoke")}
                  </Button>
                </li>
              ),
            )}
          </ul>
          {revoke.isError && <Notice tone="error">{errorText(revoke.error)}</Notice>}
        </section>
      </div>
    </Modal>
  );
}

/** "Vence en 7 h 55 min · abierto 3 veces" */
function detailOf(link: ShareLink): string {
  const left = (Date.parse(link.expiresAt) - Date.now()) / 1000;
  const expires = left > 48 * 3600 ? i18n.t("map.share.expiresOn", { date: formatDateTime(link.expiresAt) }) : i18n.t("map.share.expiresIn", { duration: formatDuration(left) });
  const opened = link.views === 0 ? i18n.t("map.share.notOpened") : i18n.t("map.share.opened", { count: link.views });
  return `${expires} · ${opened}${link.createdBy ? ` · ${link.createdBy}` : ""}`;
}
