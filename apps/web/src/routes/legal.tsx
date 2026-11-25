// Terms of use and privacy policy. The text lives in src/legal/<doc>.<language>.md,
// one file per language, and is shown in the language of the screen; the
// holder's details (name, country, email) come from the server configuration,
// so the text does not need touching when they change.
import type { Language } from "@opengps/shared";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Logo, Spinner } from "../components/ui";
import privacyEn from "../legal/privacy.en.md?raw";
import privacyEs from "../legal/privacy.es.md?raw";
import termsEn from "../legal/terms.en.md?raw";
import termsEs from "../legal/terms.es.md?raw";
import i18n, { currentLanguage } from "../lib/i18n";
import { useConfig } from "../lib/session";

const DOCS = {
  terms: { text: { es: termsEs, en: termsEn }, other: { to: "/privacy", label: "pages.legal.privacy" } },
  privacy: { text: { es: privacyEs, en: privacyEn }, other: { to: "/terms", label: "pages.legal.terms" } },
} as const satisfies Record<string, { text: Record<Language, string>; other: { to: string; label: string } }>;

/** Who the texts talk about: the product, its site and whoever operates it. */
type LegalValues = Record<"app" | "site" | "owner" | "country" | "contact", string>;

/**
 * The first way of saying something that has every value it names: in `[[A||B||C]]`, A if all of A's values are
 * there, else B, and so on. The holder and the country are optional: the text reads well without them.
 */
const choose = (text: string, values: LegalValues): string =>
  text.replace(/\[\[(.+?)\]\]/g, (_, options: string) => {
    const ways = options.split("||");
    return ways.find((way) => [...way.matchAll(/\{\{(\w+)\}\}/g)].every((m) => (values as Record<string, string>)[m[1] as string])) ?? (ways.at(-1) as string);
  });

/** Replaces {{app}}, {{site}}, {{owner}}, {{country}} and {{contact}}; a missing value is highlighted so it gets noticed. */
function fill(raw: string, values: LegalValues): ReactNode[] {
  const text = choose(raw, values);
  const labels: Record<string, string> = { owner: i18n.t("pages.legal.missing.owner"), country: i18n.t("pages.legal.missing.country"), contact: i18n.t("pages.legal.missing.contact") };
  return text.split(/(\{\{\w+\}\}|\*\*[^*]+\*\*)/g).map((part, i) => {
    const key = part.match(/^\{\{(\w+)\}\}$/)?.[1];
    if (key) {
      const value = (values as Record<string, string>)[key];
      return value ? (
        <span key={i}>{value}</span>
      ) : (
        <mark key={i} className="rounded bg-idle/20 px-1 text-ink">
          [{labels[key] ?? key}]
        </mark>
      );
    }
    const bold = part.match(/^\*\*([^*]+)\*\*$/)?.[1];
    return bold ? (
      <strong key={i} className="font-semibold text-ink">
        {bold}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    );
  });
}

/** Converts the text (headings, paragraphs and lists) into elements. */
function render(text: string, legal: LegalValues): ReactNode[] {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={blocks.length} className="list-disc space-y-2 pl-5">
        {list.map((item, i) => (
          <li key={i}>{fill(item, legal)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      continue;
    }
    flush();
    if (!line) continue;
    if (line.startsWith("# ")) {
      blocks.push(
        <h1 key={blocks.length} className="text-[30px] font-semibold leading-tight tracking-tight text-ink">
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h2 key={blocks.length} className="pt-4 text-[19px] font-semibold tracking-tight text-ink">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith("### ")) {
      blocks.push(
        <h3 key={blocks.length} className="pt-2 text-[16px] font-semibold tracking-tight text-ink">
          {line.slice(4)}
        </h3>,
      );
    } else {
      blocks.push(<p key={blocks.length}>{fill(line, legal)}</p>);
    }
  }
  flush();
  return blocks;
}

export function LegalPage({ doc }: { doc: keyof typeof DOCS }) {
  const config = useConfig();
  // Asking for the texts also redraws the page when the language changes.
  const { t } = useTranslation();
  const { other } = DOCS[doc];
  const text = DOCS[doc].text[currentLanguage()];
  return (
    <div className="min-h-full bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[760px] items-center justify-between gap-4 px-5 py-3.5">
          <Link to="/" aria-label={t("pages.legal.home")}>
            <Logo />
          </Link>
          <Link to={other.to} className="text-sm font-medium text-ink-3 underline decoration-ink/25 underline-offset-4 hover:decoration-ink">
            {t(other.label)}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[760px] px-5 py-10">
        {!config.data ? (
          <Spinner />
        ) : (
          <article className="space-y-4 text-[16px] leading-relaxed text-ink-3">
            <p className="inline-flex rounded-full bg-idle/15 px-3 py-1 text-[13px] font-medium text-ink">{t("pages.legal.draft", { version: config.data.legal.version })}</p>
            {render(text, { app: config.data.appName, site: window.location.host, owner: config.data.legal.entity, country: config.data.legal.country, contact: config.data.legal.contactEmail })}
          </article>
        )}
      </main>
    </div>
  );
}
