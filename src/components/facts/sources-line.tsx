import { useFormatter, useTranslations } from "next-intl";
import type { Fact, SourceId } from "@/lib/domain";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { safeUrl, SOURCES } from "@/lib/facts/sources";
import { StaleBadge } from "./source-note";

type Item = { source: SourceId; sourceUrl?: string; fetchedAt?: string; stale?: boolean };

/** Picks the attribution data of ok facts, skipping unavailable ones. */
export function sourceItem(fact: Fact<unknown>): Item | null {
  return fact.status === "ok"
    ? { source: fact.source, sourceUrl: fact.sourceUrl, fetchedAt: fact.fetchedAt, stale: fact.stale }
    : null;
}

/** One small line: "Source: A · checked 28.10.2026 · B · checked …". Keeps each fact attributable. */
export function SourcesLine({
  items,
  className,
  children,
}: {
  items: (Item | null)[];
  className?: string;
  children?: React.ReactNode;
}) {
  const t = useTranslations("facts");
  const ts = useTranslations("sources.items");
  const format = useFormatter();
  const list = items.filter((i): i is Item => i !== null);
  if (!list.length && !children) return null;
  return (
    <p className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs ${mutedCls} ${className ?? ""}`}>
      {list.length > 0 && <span>{t("source")}:</span>}
      {list.map((i, idx) => {
        const href = safeUrl(i.sourceUrl) ?? SOURCES[i.source].homepage;
        const label = ts(`${i.source}.label`);
        return (
          <span key={i.source} className="inline-flex flex-wrap items-center gap-x-1.5">
            {idx > 0 && <span aria-hidden="true">·</span>}
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className={linkCls}>
                {label}
              </a>
            ) : (
              <span>{label}</span>
            )}
            {i.fetchedAt && (
              <span>
                {t("checkedShort", { date: format.dateTime(new Date(i.fetchedAt), { dateStyle: "medium" }) })}
              </span>
            )}
            {i.stale && <StaleBadge />}
          </span>
        );
      })}
      {children}
    </p>
  );
}
