import { getFormatter, getTranslations } from "next-intl/server";
import { cardCls, linkCls, mutedCls, pillAccentCls, pillCls } from "@/components/ui/styles";
import type { MyFeedbackItem } from "@/lib/domain/feedback";

/** The user's own reports (server component; the list comes through RLS). */
export async function MyReports({ items }: { items: MyFeedbackItem[] }) {
  const t = await getTranslations("feedback.mine");
  const f = await getFormatter();
  return (
    <section aria-labelledby="my-reports" className={`${cardCls} flex flex-col gap-3`}>
      <h2 id="my-reports" className="font-serif text-xl font-bold text-heading">
        {t("title")}
      </h2>
      {items.length === 0 ? (
        <p className={mutedCls}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {items.map((i) => (
            <li key={i.ref} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3">
              <div className="min-w-0">
                <p className="text-sm">
                  <code className="font-semibold">{i.ref}</code> · {t(`kind.${i.kind}`)}
                </p>
                <p className={`text-xs ${mutedCls}`}>{f.dateTime(new Date(i.createdAt), { dateStyle: "medium", timeZone: "Europe/Berlin" })}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={i.status === "published" ? pillAccentCls : pillCls}>{t(`status.${i.status}`)}</span>
                {i.issueUrl && (
                  <a href={i.issueUrl} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center text-sm`}>
                    {t("openIssue")}
                    <span className="sr-only"> {i.ref}</span>
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
