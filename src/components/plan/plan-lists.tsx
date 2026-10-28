import { useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { Plan } from "@/lib/domain/plan";
import { openItemKey } from "@/lib/plan/open-items";

const box = "rounded-lg border border-neutral-300 p-3 dark:border-neutral-700 sm:p-4";

/** Tips and warnings, open items and packing list in one compact block. */
export function PlanNotes({ notes }: { notes: Plan["notes"] }) {
  const t = useTranslations("plan");
  if (notes.length === 0) return null;
  return (
    <section aria-labelledby="plan-notes" className={box}>
      <h3 id="plan-notes" className="mb-2 text-base font-semibold">
        {t("notes.title")}
      </h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {notes.map((n, i) => (
          <li
            key={i}
            className={
              n.kind === "warning"
                ? "rounded-md border border-amber-600 bg-amber-50 px-2.5 py-1.5 text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100"
                : ""
            }
          >
            <span className="font-medium">{t(`notes.${n.kind}`)}: </span>
            {n.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Read-only open items; done ones (by `openItemKey`) are struck through. The owner view uses OpenItemsEditor. */
export function PlanOpenItems({ items, done = [] }: { items: Plan["openItems"]; done?: string[] }) {
  const t = useTranslations("plan");
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="plan-open" className={box}>
      <h3 id="plan-open" className="mb-2 text-base font-semibold">
        {t("openItems.title")}
      </h3>
      <ul className="space-y-1 text-sm">
        {items.map((it, i) => {
          const isDone = done.includes(openItemKey(it.text));
          return (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true">{isDone ? "\u2611" : "\u2610"}</span>
              <span className={isDone ? "line-through" : ""}>
                {isDone && <span className="sr-only">{t("openItems.doneLabel")}: </span>}
                {it.text}
                {it.day && <span className={mutedCls}> ({t("day", { n: it.day })})</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PlanPacking({ items }: { items: Plan["packing"] }) {
  const t = useTranslations("plan");
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="plan-packing" className={box}>
      <h3 id="plan-packing" className="mb-2 text-base font-semibold">
        {t("packing.title")}
      </h3>
      <ul className="flex flex-wrap gap-1.5 text-sm">
        {items.map((it, i) => (
          <li key={i} className="rounded-full border border-neutral-400 px-2.5 py-0.5 dark:border-neutral-500">
            {it}
          </li>
        ))}
      </ul>
    </section>
  );
}
