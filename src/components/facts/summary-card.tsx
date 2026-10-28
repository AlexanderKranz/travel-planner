import { useTranslations } from "next-intl";
import type { DestinationSummary } from "@/lib/domain";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { safeUrl } from "@/lib/facts/sources";

export function SummaryCard({ data }: { data: DestinationSummary }) {
  const t = useTranslations("facts.summary");
  const url = safeUrl(data.url);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium">{data.title}</p>
      <p lang={data.lang}>{data.extract}</p>
      <p className={mutedCls}>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className={linkCls}>
            {t("readMore")}
          </a>
        )}{" "}
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
