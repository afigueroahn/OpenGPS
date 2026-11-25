// The public API: the keys another system uses to query the account, and
// how to use it.
import { API_RATE_PER_MINUTE, type ApiKey } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Plus, Trash } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Modal, Notice, Spinner } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { apiBase, createApiKey, getApiKeys, revokeApiKey } from "../../lib/integrations";
import { Card } from "../reports/kit";
import { errorText } from "../widgets";
import { Code, SecretBox } from "./kit";

const ENDPOINTS = [
  ["GET /vehicles", "integrations.api.endpoint.vehicles"],
  ["GET /vehicles/{id}/positions", "integrations.api.endpoint.positions"],
  ["GET /vehicles/{id}/trips", "integrations.api.endpoint.trips"],
  ["GET /events", "integrations.api.endpoint.events"],
  ["GET /geofences · /groups", "integrations.api.endpoint.geofences"],
  ["GET /drivers · /maintenance/orders · /routes/trips", "integrations.api.endpoint.modules"],
  ["POST /routes/trips", "integrations.api.endpoint.dispatch"],
  ["POST /vehicles/{id}/fuel/fills", "integrations.api.endpoint.fill"],
] as const;

export function ApiTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["integrations", "keys"], queryFn: getApiKeys });
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const [removing, setRemoving] = useState<ApiKey | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: ["integrations", "keys"] });
    },
  });
  const base = apiBase();
  return (
    <div className="space-y-4">
      <Card
        title={t("integrations.api.keys.title")}
        note={t("integrations.api.keys.note")}
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> {t("integrations.api.keys.new")}
          </Button>
        }
      >
        {fresh && (
          <div className="mb-4">
            <SecretBox title={t("integrations.api.keys.fresh", { name: fresh.name })} secret={fresh.secret} />
          </div>
        )}
        {keys.isLoading && <Spinner className="text-muted" />}
        {keys.isError && <Notice tone="error">{errorText(keys.error)}</Notice>}
        {keys.data &&
          (keys.data.length === 0 ? (
            <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm leading-relaxed text-ink-3">{t("integrations.api.keys.empty")}</p>
          ) : (
            <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
              {keys.data.map((k) => (
                <li key={k.id} className="flex items-center gap-3 px-4 py-2.5">
                  <KeyRound size={17} className="shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium text-ink">{k.name}</span>
                    <span className="block truncate text-[12.5px] text-muted">
                      <span className="num">{k.prefix}</span> · {k.canWrite ? t("integrations.api.keys.readWrite") : t("integrations.api.keys.readOnly")} · {k.lastUsedAt ? t("integrations.api.keys.usedAt", { when: formatDateTime(k.lastUsedAt) }) : t("integrations.api.keys.unused")}
                    </span>
                  </span>
                  <button type="button" onClick={() => setRemoving(k)} aria-label={t("integrations.api.keys.remove", { name: k.name })} title={t("common.remove")} className="shrink-0 rounded-lg p-2 text-muted hover:bg-canvas hover:text-danger">
                    <Trash size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <Card title={t("integrations.api.usage.title")} note={t("integrations.api.usage.note", { n: API_RATE_PER_MINUTE })}>
        <div className="space-y-3">
          <p className="text-[13.5px] leading-relaxed text-ink-3">{t("integrations.api.usage.lead")}</p>
          <Code>{`curl ${base}/vehicles \\\n  -H "Authorization: Bearer TU_CLAVE"`}</Code>
          <ul className="divide-y divide-line rounded-[10px] border border-line text-[13px]">
            {ENDPOINTS.map(([route, what]) => (
              <li key={route} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="num shrink-0 font-medium text-ink sm:w-[46%]">{route}</span>
                <span className="text-ink-3">{t(what)}</span>
              </li>
            ))}
          </ul>
          <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-ink hover:underline">
            <ExternalLink size={14} aria-hidden="true" /> {t("integrations.api.usage.openapi")}
          </a>
          <p className="text-[12.5px] leading-relaxed text-muted">{t("integrations.api.usage.openapiNote")}</p>
        </div>
      </Card>

      {creating && (
        <KeyDialog
          onClose={() => setCreating(false)}
          onCreated={(name, secret, next) => {
            queryClient.setQueryData(["integrations", "keys"], next);
            setFresh({ name, secret });
            setCreating(false);
          }}
        />
      )}
      {removing && (
        <Modal open onClose={() => setRemoving(null)} title={t("integrations.api.remove.title")}>
          <div className="space-y-4">
            <p className="text-[15px] leading-relaxed text-ink-3">
              {t("integrations.api.remove.body", { name: removing.name })}
            </p>
            {revoke.isError && <Notice tone="error">{errorText(revoke.error)}</Notice>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(removing.id)}>
                {t("common.remove")}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function KeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, secret: string, keys: ApiKey[]) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [canWrite, setCanWrite] = useState(false);
  const create = useMutation({ mutationFn: () => createApiKey({ name: name.trim(), canWrite }), onSuccess: (r) => onCreated(name.trim(), r.secret, r.keys) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  return (
    <Modal open onClose={onClose} title={t("integrations.api.dialog.title")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label={t("integrations.api.dialog.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("integrations.api.dialog.namePlaceholder")} autoFocus />
        <label className="flex cursor-pointer items-start gap-3 text-[14.5px] text-ink">
          <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} className="mt-0.5 h-4 w-4 accent-ink" />
          <span>
            {t("integrations.api.dialog.canWrite")}
            <span className="block text-[12.5px] leading-relaxed text-muted">{t("integrations.api.dialog.canWriteNote")}</span>
          </span>
        </label>
        {create.isError && <Notice tone="error">{errorText(create.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
