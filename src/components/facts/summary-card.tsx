import { useTranslations } from "next-intl";
import type { DestinationSummary } from "@/lib/domain";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { safeUrl } from "@/lib/facts/sources";
import { summaryParagraphs } from "@/lib/facts/glance";

/** Magazine-style lead text: large heading, readable measure, first paragraph as lead. */
export function SummaryCard({ data }: { data: DestinationSummary & { paragraphs?: string[] } }) {
  const t = useTranslations("facts.summary");
  const url = safeUrl(data.url);
  const paragraphs = summaryParagraphs(data);
  return (
    <div lang={data.lang} className="flex max-w-prose flex-col gap-3">
      <h3 className="text-2xl font-bold tracking-tight sm:text-3xl">{data.title}</h3>
      {paragraphs.map((p, i) => (
        <p
          key={i}
          className={i === 0 ? "text-lg leading-relaxed" : "leading-relaxed text-ink"}
        >
          {p}
        </p>
      ))}
      <p className={`text-xs ${mutedCls}`}>
        {url && (
          <>
            <a href={url} target="_blank" rel="noopener noreferrer" className={`${linkCls} text-sm`}>
              {t("readMore")}
            </a>
            {" · "}
          </>
        )}
        {t("license")}{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className={linkCls}
        >
          CC BY-SA 4.0
        </a>
      </p>
    </div>
  );
}
