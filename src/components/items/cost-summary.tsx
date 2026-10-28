import { useFormatter, useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { CostSummary, Money } from "@/lib/domain/items";
import { isRange } from "./helpers";

/** Small table per currency: rows per person / total, columns booked / expected (range for alternatives). */
export function CostSummaryView({ costs, headingLevel = 3 }: { costs: CostSummary; headingLevel?: 3 | 4 }) {
  const t = useTranslations("costs");
  const f = useFormatter();
  if (costs.currencies.length === 0) return null;
  const H = `h${headingLevel}` as "h3" | "h4";
  const many = costs.currencies.length > 1;
  const th = "px-2 py-1.5 text-left text-xs font-semibold";
  return (
    <section aria-labelledby="cost-title" className="flex min-w-0 flex-col gap-3 rounded-lg border border-neutral-300 p-3 dark:border-neutral-700 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <H id="cost-title" className="text-base font-semibold">
          {t("title")}
        </H>
        <p className={`text-sm ${mutedCls}`}>
          {costs.partySize ? t("forPeople", { count: costs.partySize }) : t("noParty")}
        </p>
      </div>
      {costs.currencies.map((c) => {
        const money = (cents: number) => f.number(cents / 100, { style: "currency", currency: c.currency });
        const range = (m: Money) =>
          isRange(m) ? `${money(m.minCents)} – ${money(m.maxCents)}` : money(m.minCents);
        const rows = [
          { key: "perPerson", booked: money(c.booked.perPersonCents), expected: range(c.expected.perPerson) },
          { key: "total", booked: money(c.booked.totalCents), expected: range(c.expected.total) },
        ] as const;
        return (
          <div key={c.currency} className="min-w-0">
            <table className="w-full table-fixed border-collapse text-sm tabular-nums">
              <caption className={many ? "mb-1 text-left text-sm font-medium" : "sr-only"}>{c.currency}</caption>
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[30%]" />
                <col />
              </colgroup>
              <thead>
                <tr className="border-b border-neutral-300 dark:border-neutral-700">
                  <td />
                  <th scope="col" className={th}>
                    {t("booked")}
                  </th>
                  <th scope="col" className={th}>
                    {t("expected")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-neutral-200 last:border-0 dark:border-neutral-800">
                    <th scope="row" className="px-2 py-1.5 text-left text-xs font-medium">
                      {t(r.key)}
                    </th>
                    <td className="break-words px-2 py-1.5 font-semibold">{r.booked}</td>
                    <td className="break-words px-2 py-1.5">{r.expected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(c.unpriced > 0 || c.incomplete > 0 || c.counts.rejected > 0) && (
              <ul className={`mt-1.5 flex flex-wrap gap-x-3 text-xs ${mutedCls}`}>
                {c.unpriced > 0 && <li>{t("unpriced", { count: c.unpriced })}</li>}
                {c.incomplete > 0 && <li>{t("incomplete", { count: c.incomplete })}</li>}
                {c.counts.rejected > 0 && <li>{t("rejected", { count: c.counts.rejected })}</li>}
              </ul>
            )}
          </div>
        );
      })}
      <p className={`text-xs ${mutedCls}`}>{t("noFx")}</p>
    </section>
  );
}
