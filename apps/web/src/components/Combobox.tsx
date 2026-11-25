// A dropdown with a search box: the person types to narrow a long list and
// picks one option. Keyboard: arrows move, Enter picks, Escape closes.
import clsx from "clsx";
import { Check, ChevronsUpDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

export interface ComboOption {
  id: string;
  label: string;
  /** Smaller text next to the label. */
  note?: string;
  /** Heading the option is listed under. Options of a group must come together. */
  group?: string;
  /** Other words the option is found by. */
  keywords?: string;
}

/** Lower case and without accents, so "camion" finds "Camión". */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder,
  hint,
  error,
  emptyText,
  className,
}: {
  label: string;
  options: ComboOption[];
  /** Id of the chosen option, or "" when none is. */
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  /** What to say when nothing matches what was typed. */
  emptyText: string;
  className?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const chosen = options.find((o) => o.id === value);

  const shown = useMemo(() => {
    const words = plain(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return options;
    return options.filter((o) => {
      const text = plain(`${o.label} ${o.note ?? ""} ${o.group ?? ""} ${o.keywords ?? ""}`);
      return words.every((w) => text.includes(w));
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  // The highlighted option stays in view while moving with the arrows.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.id === value)));
    setOpen(true);
  };
  const pick = (option: ComboOption) => {
    onChange(option.id);
    setOpen(false);
    setQuery("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (shown.length === 0 ? 0 : (a + step + shown.length) % shown.length));
    } else if (e.key === "Enter" && open) {
      // Inside a form, Enter picks the option instead of submitting.
      e.preventDefault();
      const option = shown[active];
      if (option) pick(option);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={root} className={clsx("relative", className)}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-ink-3">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${id}-option-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={open ? query : (chosen?.label ?? "")}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={show}
          onClick={() => !open && show()}
          onKeyDown={onKeyDown}
          className={clsx(
            "h-11 w-full rounded-[10px] border bg-surface pl-3.5 pr-10 text-[15px] text-ink placeholder:text-faint",
            "transition-shadow focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10",
            error ? "border-danger" : "border-line",
          )}
        />
        <ChevronsUpDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
      </div>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label={label} className="absolute left-0 right-0 z-30 mt-1.5 max-h-64 overflow-y-auto rounded-[12px] border border-line bg-surface p-1 shadow-xl">
          {shown.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">{emptyText}</li>}
          {shown.map((option, index) => {
            const heading = option.group && option.group !== shown[index - 1]?.group ? option.group : null;
            return (
              <li key={option.id} role="presentation">
                {heading && <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-muted">{heading}</p>}
                <div
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={option.id === value}
                  data-index={index}
                  // mousedown, not click: the input must not lose focus first and close the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(option);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={clsx("flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm", index === active ? "bg-canvas text-ink" : "text-ink-3")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{option.label}</span>
                    {option.note && <span className="ml-2 text-[13px] text-muted">{option.note}</span>}
                  </span>
                  {option.id === value && <Check size={15} className="shrink-0 text-signal-ink" aria-hidden="true" />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {(error || hint) && (
        <p id={`${id}-note`} className={clsx("mt-1.5 text-[13px]", error ? "text-danger" : "text-muted")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}
