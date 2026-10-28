import { useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { Plan } from "@/lib/domain/plan";
import { openItemKey } from "@/lib/plan/open-items";

const box = "rounded-[14px] border border-line bg-card p-4 sm:p-5";

/** Tips and warnings, open items and packing list in one compact block. */
export function PlanNotes({ notes }: { notes: Plan["notes"] }) {
  const t = useTranslations("plan");
  if (notes.length === 0) return null;
  return (
    <section aria-labelledby="plan-notes" className={box}>
      <h3 id="plan-notes" className="mb-3 text-lg font-bold">
        {t("notes.title")}
      </h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {notes.map((n, i) => (
          <li
            key={i}
            className={
              n.kind === "warning"
                ? "rounded-[10px] bg-warn-bg px-3 py-2 text-warn-fg"
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
      <h3 id="plan-open" className="mb-3 text-lg font-bold">
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
      <h3 id="plan-packing" className="mb-3 text-lg font-bold">
        {t("packing.title")}
      </h3>
      <ul className="flex flex-wrap gap-1.5 text-sm">
        {items.map((it, i) => (
          <li key={i} className="rounded-full border border-line-strong bg-card px-3 py-1">
            {it}
          </li>
        ))}
      </ul>
    </section>
  );
}
