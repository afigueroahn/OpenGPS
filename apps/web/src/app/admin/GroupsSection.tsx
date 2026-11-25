// Group management: create, rename and delete. Vehicles are
// assigned to a group when editing them.
import type { VehicleGroup } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice } from "../../components/ui";
import { createGroup, deleteGroup, renameGroup } from "../../lib/api";
import { errorText } from "../widgets";

export function GroupsSection({ groups }: { groups: VehicleGroup[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["groups"] });
    await queryClient.invalidateQueries({ queryKey: ["vehicles"] });
  };
  const fail = (err: unknown) => setError(errorText(err));

  const add = useMutation({
    mutationFn: () => createGroup(name.trim()),
    onSuccess: async () => {
      setName("");
      setError(null);
      await refresh();
    },
    onError: fail,
  });
  const rename = useMutation({
    mutationFn: (g: { id: string; name: string }) => renameGroup(g.id, g.name.trim()),
    onSuccess: async () => {
      setEditing(null);
      setError(null);
      await refresh();
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteGroup(id), onSuccess: refresh, onError: fail });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate();
  };

  return (
    <div className="space-y-4">
        {groups.length > 0 && (
          <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center gap-2 px-3 py-2.5">
                {editing?.id === g.id ? (
                  <form
                    className="flex min-w-0 flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editing.name.trim()) rename.mutate(editing);
                    }}
                  >
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ id: g.id, name: e.target.value })}
                      onFocus={(e) => e.target.select()}
                      maxLength={40}
                      aria-label={t("admin.vehicleGroups.name")}
                      autoFocus
                      className="h-9 min-w-0 flex-1 rounded-lg border border-ink px-2.5 text-sm focus:outline-none focus:ring-3 focus:ring-ink/10"
                    />
                    <IconButton label={t("admin.vehicleGroups.saveName")} type="submit">
                      <Check size={16} />
                    </IconButton>
                    <IconButton label={t("common.cancel")} onClick={() => setEditing(null)}>
                      <X size={16} />
                    </IconButton>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{g.name}</span>
                    <span className="num shrink-0 text-[13px] text-muted">{t("admin.vehicleGroups.vehicles", { count: g.vehicleCount })}</span>
                    <IconButton label={t("admin.vehicleGroups.rename", { name: g.name })} onClick={() => setEditing({ id: g.id, name: g.name })}>
                      <Pencil size={15} />
                    </IconButton>
                    <IconButton label={t("admin.vehicleGroups.delete", { name: g.name })} onClick={() => remove.mutate(g.id)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={submit} className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="grupo-nuevo" className="mb-1.5 block text-[13px] font-medium text-ink-3">
              {t("admin.vehicleGroups.new")}
            </label>
            <input
              id="grupo-nuevo"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder={t("admin.vehicleGroups.placeholder")}
              className="h-11 w-full rounded-[10px] border border-line bg-surface px-3.5 text-[15px] placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
            />
          </div>
          <Button type="submit" size="lg" className="h-11" loading={add.isPending} disabled={!name.trim()}>
            {t("common.create")}
          </Button>
        </form>

        {error && <Notice tone="error">{error}</Notice>}
        <p className="text-[13px] text-muted">{t("admin.vehicleGroups.note")}</p>
    </div>
  );
}

function IconButton({ label, children, onClick, type = "button" }: { label: string; children: React.ReactNode; onClick?: () => void; type?: "button" | "submit" }) {
  return (
    <button type={type} onClick={onClick} aria-label={label} title={label} className="shrink-0 rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink">
      {children}
    </button>
  );
}
