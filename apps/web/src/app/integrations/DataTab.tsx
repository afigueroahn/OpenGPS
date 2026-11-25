// Taking data out and bringing it in: export vehicles, drivers and geofences to a
// spreadsheet, and load them from a CSV file with the same columns.
import { type ImportResult, type ModuleKey, TRANSFER_INFO, TRANSFER_KINDS, type TransferKind } from "@opengps/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, Notice } from "../../components/ui";
import { exportUrl, importCsv } from "../../lib/integrations";
import { Card } from "../reports/kit";
import { errorText } from "../widgets";
import { select } from "./kit";

const link = "inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-canvas";

export function DataTab({ modules, canManage }: { modules: ModuleKey[]; canManage: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const kinds = TRANSFER_KINDS.filter((k) => !TRANSFER_INFO[k].requires || modules.includes(TRANSFER_INFO[k].requires as ModuleKey));
  const [kind, setKind] = useState<TransferKind>("vehicles");
  const [done, setDone] = useState<{ kind: TransferKind; file: string; result: ImportResult } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = useMutation({
    mutationFn: async (file: File) => ({ file: file.name, result: await importCsv(kind, await file.text()) }),
    onSuccess: ({ file, result }) => {
      setDone({ kind, file, result });
      // What was loaded appears in the rest of the platform.
      void queryClient.invalidateQueries({ queryKey: ["vehicles"] });
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
      void queryClient.invalidateQueries({ queryKey: ["geofences"] });
      void queryClient.invalidateQueries({ queryKey: ["drivers"] });
    },
    onError: () => setDone(null),
  });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title={t("integrations.data.export.title")} note={t("integrations.data.export.note")}>
        <ul className="-mx-4 -mb-4 divide-y divide-line border-t border-line">
          {kinds.map((k) => (
            <li key={k} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <span className="text-[14.5px] font-medium text-ink">{t(`shared.transfer.${k}`)}</span>
              <span className="flex gap-2">
                <a href={exportUrl(k, "xlsx")} download className={link}>
                  <Download size={14} aria-hidden="true" /> Excel
                </a>
                <a href={exportUrl(k, "csv")} download className={link}>
                  <Download size={14} aria-hidden="true" /> CSV
                </a>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t("integrations.data.import.title")} note={t("integrations.data.import.note")}>
        {canManage ? (
          <div className="space-y-3">
            <div>
              <label htmlFor="importar-que" className="mb-1.5 block text-[13px] font-medium text-ink-3">
                {t("integrations.data.import.what")}
              </label>
              <select id="importar-que" value={kind} onChange={(e) => setKind(e.target.value as TransferKind)} className={select}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {t(`shared.transfer.${k}`)}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-3">
              <Trans i18nKey="integrations.data.import.columns" values={{ columns: t(`shared.transferColumns.${kind}`) }} components={{ c: <span className="num text-ink" /> }} />{" "}
              {kind === "vehicles" ? t("integrations.data.import.vehiclesNote") : kind === "geofences" ? t("integrations.data.import.geofencesNote") : t("integrations.data.import.driversNote")}{" "}
              {t("integrations.data.import.existing")}
            </p>
            <p className="text-[12.5px] text-muted">{t("integrations.data.import.easiest")}</p>
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              aria-label={t("integrations.data.import.file")}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) load.mutate(file);
                e.target.value = "";
              }}
            />
            <Button loading={load.isPending} onClick={() => input.current?.click()}>
              <FileUp size={16} aria-hidden="true" /> {t("integrations.data.import.choose")}
            </Button>
            {load.isError && <Notice tone="error">{errorText(load.error)}</Notice>}
            {done && (
              <div className="space-y-2">
                <Notice tone={done.result.errors.length > 0 ? "info" : "success"}>
                  {done.file}: {t("integrations.data.import.loaded", { count: done.result.created })}
                  {done.result.skipped > 0 && `, ${t("integrations.data.import.skipped", { count: done.result.skipped })}`}
                  {done.result.errors.length > 0 && `, ${t("integrations.data.import.failed", { n: done.result.errors.length })}`}.
                </Notice>
                {done.result.errors.length > 0 && (
                  <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-[10px] border border-line text-[13px]">
                    {done.result.errors.map((e) => (
                      <li key={`${e.row}-${e.message}`} className="flex gap-3 px-3 py-1.5">
                        <span className="num shrink-0 text-muted">{t("integrations.data.import.row", { row: e.row })}</span>
                        <span className="text-ink-3">{e.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="rounded-[12px] bg-canvas px-4 py-3 text-sm text-ink-3">{t("integrations.data.import.noPermission")}</p>
        )}
      </Card>
    </div>
  );
}
