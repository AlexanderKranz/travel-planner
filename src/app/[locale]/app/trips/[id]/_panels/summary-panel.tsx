import { getTranslations } from "next-intl/server";
import { FactUnavailable } from "@/components/facts/fact-unavailable";
import { SourcesLine, sourceItem } from "@/components/facts/sources-line";
import { SummaryCard } from "@/components/facts/summary-card";
import { getSummaryFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

/**
 * "About the destination" next to the trip header (Alex, 2026-10-29): beside it on desktop, a collapsed box
 * below the header buttons on phones. The text is rendered twice (one variant hidden per breakpoint) because a
 * <details> cannot be forced open by CSS alone.
 */
export async function SummaryPanel({ trip, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const fact = await getSummaryFacts(trip, ctx);
  const body =
    fact.status === "ok" ? (
      <>
        <SummaryCard data={fact.data} />
        <SourcesLine items={[sourceItem(fact)]} className="mt-2" />
      </>
    ) : (
      <FactUnavailable fact={fact} />
    );
  return (
    <>
      <details className="group rounded-lg border border-line lg:hidden" data-no-print>
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-lg px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-focus">
          {t("summary.title")}
          <span aria-hidden="true" className="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <div className="border-t border-line p-4">{body}</div>
      </details>
      <article aria-labelledby="summary-eyebrow" className="hidden min-w-0 lg:block">
        <h2 id="summary-eyebrow" className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-text">
          {t("summary.title")}
        </h2>
        {body}
      </article>
    </>
  );
}

/** Placeholder while the summary loads: nothing on phones (the box is collapsed anyway), a skeleton on desktop. */
export function SummaryFallback({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="hidden min-w-0 lg:block">
      {children}
    </section>
  );
}
