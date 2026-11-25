// Shared interface pieces.
import type { VehicleStatus } from "@opengps/shared";
import { VEHICLE_STATUS_COLOR } from "@opengps/shared";
import clsx from "clsx";
import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** `iconOnly` leaves just the mark, for a folded menu. */
export function Logo({ dark = false, size = 30, iconOnly = false }: { dark?: boolean; size?: number; iconOnly?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill={dark ? "#1a2233" : "#101623"} />
        <path d="M16 6.5c-4.1 0-7.4 3.2-7.4 7.2 0 5.2 7.4 11.8 7.4 11.8s7.4-6.600 7.400-11.800c0-4-3.300-7.200-7.400-7.200z" fill="#3ddc97" />
        <circle cx="16" cy="13.800" r="2.900" fill={dark ? "#1a2233" : "#101623"} />
      </svg>
      {!iconOnly && (
        <span className={clsx("text-[15px] font-semibold tracking-tight", dark ? "text-white" : "text-ink")}>
          Open<span className={dark ? "text-white/60" : "text-muted"}>GPS</span>
        </span>
      )}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "signal";
  size?: "md" | "lg" | "sm";
  loading?: boolean;
  full?: boolean;
};

export function Button({ variant = "primary", size = "md", loading, full, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55",
        size === "lg" && "h-12 px-5 text-[15px]",
        size === "md" && "h-10 px-4 text-sm",
        size === "sm" && "h-8 px-3 text-[13px]",
        full && "w-full",
        variant === "primary" && "bg-primary text-on-primary hover:bg-primary/85",
        variant === "signal" && "bg-signal text-ink hover:bg-[#5ae6ab]",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-canvas",
        variant === "ghost" && "text-ink-3 hover:bg-ink/5",
        variant === "danger" && "border border-danger/30 bg-surface text-danger hover:bg-danger/5",
        className,
      )}
    >
      {loading && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | null; mono?: boolean };

export function Field({ label, hint, error, mono, className, id, ...rest }: FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-ink-3">
        {label}
      </label>
      <input
        id={inputId}
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${inputId}-nota` : undefined}
        className={clsx(
          "h-11 w-full rounded-[10px] border bg-surface px-3.5 text-[15px] text-ink placeholder:text-faint",
          "transition-shadow focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10",
          error ? "border-danger" : "border-line",
          mono && "num",
        )}
      />
      {(error || hint) && (
        <p id={`${inputId}-nota`} className={clsx("mt-1.5 text-[13px]", error ? "text-danger" : "text-muted")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "success"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={clsx(
        "rounded-[10px] border px-3.5 py-2.5 text-sm",
        tone === "error" && "border-danger/25 bg-danger/5 text-danger",
        tone === "success" && "border-moving/25 bg-moving/5 text-signal-ink",
        tone === "info" && "border-line bg-canvas text-ink-3",
      )}
    >
      {children}
    </div>
  );
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  const { t } = useTranslation();
  return <LoaderCircle size={size} className={clsx("animate-spin", className)} aria-label={t("map.ui.loading")} />;
}

export function StatusDot({ status, pulse }: { status: VehicleStatus; pulse?: boolean }) {
  const color = VEHICLE_STATUS_COLOR[status];
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      {pulse && <span className="pulse-ring absolute inset-0 rounded-full" style={{ background: color }} />}
      <span className={clsx("relative h-2.5 w-2.5 rounded-full", status === "no_device" && "opacity-40")} style={{ background: color }} />
    </span>
  );
}

export function StatusLabel({ status, className }: { status: VehicleStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={clsx("inline-flex items-center gap-1.5", className)}>
      <StatusDot status={status} pulse={status === "moving" || status === "pending"} />
      {t(`shared.vehicleStatus.${status}`)}
    </span>
  );
}

/** Modal window. On phones it slides up from the bottom; on large screens it is centered. */
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  required,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  /** Cannot be closed without answering: no close button. */
  required?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  // The content is mounted with the dialog already open: this way the field that asks for
  // the cursor (autoFocus) receives it, and anything that measures its size on mount measures correctly.
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    setShown(open);
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && shown && (
        <div
          className={clsx(
            "flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] bg-surface shadow-2xl sm:rounded-[18px]",
            wide ? "sm:max-w-[620px]" : "sm:max-w-[440px]",
          )}
        >
          <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
            <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
            {!required && (
              <button type="button" onClick={onClose} aria-label={t("common.close")} className="-mr-1.5 rounded-lg p-1.5 text-muted hover:bg-canvas hover:text-ink">
                <X size={18} />
              </button>
            )}
          </header>
          <div className="overflow-y-auto px-5 py-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** Text to copy: SMS commands, server and port. */
export function CopyText({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* no clipboard permission: the text stays visible to copy by hand */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={t("common.copy")}
      className="group flex w-full items-center justify-between gap-3 rounded-[10px] bg-panel px-3.5 py-2.5 text-left text-white hover:bg-panel-2"
    >
      <span className="min-w-0">
        {label && <span className="block text-[11px] font-medium uppercase tracking-wider text-white/50">{label}</span>}
        <span className="num block whitespace-pre-wrap break-all text-[13.5px]">{value}</span>
      </span>
      <span className="shrink-0 text-white/60 group-hover:text-white" aria-live="polite">
        {copied ? <Check size={16} className="text-signal" aria-label={t("common.copied")} /> : <Copy size={16} aria-label={t("common.copy")} />}
      </span>
    </button>
  );
}
