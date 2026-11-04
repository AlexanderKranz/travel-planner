import { getFormatter, getTranslations } from "next-intl/server";
import type { FeedbackStats } from "@/lib/domain/feedback";
import { mutedCls } from "@/components/ui/styles";
import { FeedbackLookupForm } from "./feedback-lookup";
import { Bar, Section, Stat, Stats } from "./parts";

/** Aggregates only (counts, no identifiers, no text) plus the reference lookup. Without stats (read failed) the lookup still works. */
export async function FeedbackSection({ stats }: { stats: FeedbackStats | null }) {
  const t = await getTranslations("admin.feedback");
  const f = await getFormatter();
  if (!stats) {
    return (
      <Section id="admin-feedback" title={t("title")} collapsed>
        <p className={mutedCls}>{t("statsUnavailable")}</p>
        <FeedbackLookupForm />
      </Section>
    );
  }
  const total = stats.issuesPerDay.reduce((n, d) => n + d.count, 0);
  const today = stats.issuesPerDay.at(-1)?.count ?? 0;
  const max = Math.max(1, ...stats.issuesPerDay.map((d) => d.count));
  return (
    <Section id="admin-feedback" title={t("title")} collapsed>
<p className={mutedCls}>{t("intro")}</p>
      <Stats>
        <Stat label={t("today")} value={today} />
        <Stat label={t("total14")} value={total} />
        <Stat label={t("pending")} value={stats.pending} hint={t("pendingHint")} />
        <Stat label={t("failed")} value={stats.failed} />
      </Stats>
      <p className="text-sm">
        <span className="font-medium">{t("lastError")}: </span>
        {stats.lastError ? (
          <>
            <code>{stats.lastError.errorClass}</code>{" "}
            <span className={mutedCls}>
              ({f.dateTime(new Date(stats.lastError.at), { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" })})
            </span>
          </>
        ) : (
          <span className={mutedCls}>{t("noError")}</span>
        )}
      </p>
      <details className="rounded-lg border border-line p-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-heading">{t("perDay")}</summary>
        <div className="mt-2 flex flex-col gap-2">
          {stats.issuesPerDay.map((d) => (
            <Bar
              key={d.day}
              label={f.dateTime(new Date(`${d.day}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}
              valueText={String(d.count)}
              widthPct={(d.count / max) * 100}
            />
          ))}
        </div>
      </details>
      <FeedbackLookupForm />
    </Section>
  );
}
