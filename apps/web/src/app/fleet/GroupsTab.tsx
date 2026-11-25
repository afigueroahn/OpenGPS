// The group tree: branches, zones, routes... A group can hang from another,
// and what applies to a group also applies to those that hang from it.
import type { VehicleGroup } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CornerDownRight, Folder } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice } from "../../components/ui";
import { createGroup, setGroupParent } from "../../lib/api";
import { Card, selectClass } from "../reports/kit";
import { errorText } from "../widgets";
import { groupTree, indented, withChildren } from "./tree";

export function GroupsTab({ groups, canManage }: { groups: VehicleGroup[]; canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const tree = useMemo(() => groupTree(groups), [groups]);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["groups"] });
    // Moving a group changes which vehicles each group covers.
    await queryClient.invalidateQueries({ queryKey: ["vehicles"] });
  };
  const move = useMutation({
    mutationFn: (m: { id: string; parentId: string | null }) => setGroupParent(m.id, m.parentId),
    onSuccess: async (next) => {
      setError(null);
      queryClient.setQueryData(["groups"], next);
      await refresh();
    },
    onError: (err) => setError(errorText(err)),
  });
  const add = useMutation({
    mutationFn: async () => {
      const group = await createGroup(name.trim());
      if (parentId) await setGroupParent(group.id, parentId);
    },
    onSuccess: async () => {
      setName("");
      setError(null);
      await refresh();
    },
    onError: async (err) => {
      setError(errorText(err));
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate();
  };

  return (
    <div className="space-y-4">
      <Card title={t("fleet.groups.title")} note={t("fleet.groups.note")}>
        <p className="mb-4 text-[13.5px] leading-relaxed text-ink-3">
          {t("fleet.groups.lead")}
        </p>
        {error && (
          <div className="mb-4">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {tree.length === 0 ? (
          <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{canManage ? t("fleet.groups.emptyManage") : t("fleet.groups.empty")}</p>
        ) : (
          <ul className="-mx-4 divide-y divide-line border-y border-line">
            {tree.map((g) => {
              // A group cannot hang from itself or from one of its own.
              const own = withChildren(groups, g.id);
              const options = tree.filter((o) => !own.has(o.id));
              return (
                <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
                  <span className="flex min-w-0 flex-1 basis-56 items-center gap-2" style={{ paddingLeft: `${Math.min(g.depth, 6) * 22}px` }}>
                    {g.depth > 0 ? <CornerDownRight size={15} className="shrink-0 text-faint" aria-hidden="true" /> : <Folder size={16} className="shrink-0 text-muted" aria-hidden="true" />}
                    <span className="min-w-0">
                      <span className="block truncate text-[14.5px] font-medium text-ink">{g.name}</span>
                      <span className="block text-[12.5px] text-muted">
                        {t("fleet.groups.vehicles", { count: g.vehicleCount })}
                        {g.total !== g.vehicleCount && <> · {t("fleet.groups.withSubgroups", { n: g.total })}</>}
                      </span>
                    </span>
                  </span>
                  {canManage && (
                    <label className="flex items-center gap-2 text-[13px] text-muted">
                      {t("fleet.groups.parent")}
                      <select
                        aria-label={t("fleet.groups.parentOf", { name: g.name })}
                        value={g.parentId ?? ""}
                        disabled={move.isPending}
                        onChange={(e) => move.mutate({ id: g.id, parentId: e.target.value || null })}
                        className={`${selectClass} h-9 w-[190px] text-[13px]`}
                      >
                        <option value="">{t("common.none")}</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {indented(o)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canManage && (
          <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2" noValidate>
            <label className="min-w-0 flex-1 basis-52">
              <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{t("fleet.groups.new")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("fleet.groups.namePlaceholder")} className={`${selectClass} w-full`} />
            </label>
            {tree.length > 0 && (
              <label className="min-w-0 flex-1 basis-44 sm:flex-none">
                <span className="mb-1.5 block text-[13px] font-medium text-ink-3">{t("fleet.groups.parent")}</span>
                <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={`${selectClass} w-full`}>
                  <option value="">{t("common.none")}</option>
                  {tree.map((o) => (
                    <option key={o.id} value={o.id}>
                      {indented(o)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button type="submit" loading={add.isPending} disabled={!name.trim()}>
              {t("common.create")}
            </Button>
          </form>
        )}
        <p className="mt-4 text-[12.5px] text-muted">{t("fleet.groups.footer")}</p>
      </Card>
    </div>
  );
}
