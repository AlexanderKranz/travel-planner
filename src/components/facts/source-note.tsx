import { useFormatter, useTranslations } from "next-intl";
import type { SourceId } from "@/lib/domain";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { safeUrl, SOURCE_META } from "./source-meta";

export function StaleBadge() {
  const t = useTranslations("facts");
  return (
    <span className="inline-flex items-center rounded-full border border-amber-700 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100">
      {t("stale")}
    </span>
  );
}

/** Source, check date and stale marker; closes every fact block. */
export function SourceNote({
  source,
  sourceUrl,
  fetchedAt,
  stale,
  children,
}: {
  source: SourceId;
  sourceUrl?: string;
  fetchedAt?: string;
  stale?: boolean;
  children?: React.ReactNode;
}) {
  const t = useTranslations("facts");
  const ts = useTranslations("sources.items");
  const format = useFormatter();
  const href = safeUrl(sourceUrl) ?? SOURCE_META[source].homepage;
  const label = ts(`${source}.label`);
  return (
    <footer className={`mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${mutedCls}`}>
      <span>
        {t("source")}:{" "}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className={linkCls}>
            {label}
          </a>
        ) : (
          label
        )}
      </span>
      {fetchedAt && (
        <span>
          · {t("checked", { date: format.dateTime(new Date(fetchedAt), { dateStyle: "medium" }) })}
        </span>
      )}
      {stale && <StaleBadge />}
      {stale && <span>{t("staleHint")}</span>}
      {children}
    </footer>
  );
}
