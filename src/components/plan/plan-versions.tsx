import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import type { PlanVersionMeta } from "@/lib/domain/plan";
import { summarizeFeedback } from "./helpers";
import { RestoreButton } from "./restore-button";

function FeedbackText({ meta }: { meta: PlanVersionMeta }) {
  const t = useTranslations("plan");
  const s = summarizeFeedback(meta);
  switch (s.type) {
    case "swap_days":
      return <>{t("versions.swap", { a: s.a, b: s.b })}</>;
    case "set_best":
      return <>{s.n ? t("versions.best", { n: s.n }) : t("versions.bestNone")}</>;
    case "act_edit":
      return <>{t(`versions.${s.edit}`)}</>;
    case "chips":
      return (
        <>
          {[...s.chips.map((c) => t(`iterate.chips.${c}`)), ...(s.text ? [`„${s.text.slice(0, 60)}${s.text.length > 60 ? "…" : ""}“`] : [])].join(", ")}
        </>
      );
    default:
      return null;
  }
}

/** Version history as a disclosure; "View" links use ?v=, "Restore" asks for confirmation. */
export function PlanVersions({
  tripId,
  versions,
  shown,
  busy,
}: {
  tripId: string;
  versions: PlanVersionMeta[];
  /** Version number currently displayed. */
  shown: number;
  busy: boolean;
}) {
  const t = useTranslations("plan.versions");
  const tk = useTranslations("plan.versionKinds");
  const f = useFormatter();
  const latest = versions[0]?.versionNo;
  return (
    <section aria-label={t("aria")} className={`${cardCls} min-w-0 p-0`}>
      <details open={versions.length <= 6} className="group">
        <summary
          className={`flex min-h-11 cursor-pointer items-center px-4 text-lg font-bold ${linkCls} no-underline`}
        >
          {t("title", { count: versions.length })}
        </summary>
        <ol className="flex flex-col divide-y divide-line px-4 pb-2">
          {versions.map((v) => {
            const isShown = v.versionNo === shown;
            return (
              <li key={v.versionNo} className="flex min-w-0 flex-col gap-1 py-2 text-sm">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">v{v.versionNo}</span>
                  <time dateTime={v.createdAt} className={mutedCls}>
                    {f.relativeTime(new Date(v.createdAt), new Date())}
                  </time>
                  {isShown && (
                    <span className="rounded-full border border-info-line px-2 text-xs">
                      {t("shown")}
                    </span>
                  )}
                </p>
                <p className="min-w-0 break-words">
                  {tk(v.kind)}
                  {v.restoredFrom ? ` (${t("restoredFrom", { n: v.restoredFrom })})` : ""}
                  {v.feedback ? <>: <FeedbackText meta={v} /></> : null}
                </p>
                {v.changedDays.length > 0 && (
                  <p className={`text-xs ${mutedCls}`}>{t("changedDays", { days: v.changedDays.join(", ") })}</p>
                )}
                <div className="flex flex-wrap gap-x-4">
                  {!isShown && (
                    <Link
                      href={v.versionNo === latest ? `/app/trips/${tripId}` : `/app/trips/${tripId}?v=${v.versionNo}`}
                      scroll={false}
                      className={`${linkCls} inline-flex min-h-11 items-center`}
                    >
                      {t("view")}
                      <span className="sr-only"> v{v.versionNo}</span>
                    </Link>
                  )}
                  {v.versionNo !== latest && <RestoreButton tripId={tripId} versionNo={v.versionNo} disabled={busy} />}
                </div>
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}
