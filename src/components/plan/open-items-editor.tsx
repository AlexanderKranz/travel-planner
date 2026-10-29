"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { ActionError } from "@/lib/domain";
import type { Plan } from "@/lib/domain/plan";
import { openItemKey } from "@/lib/plan/open-items";
import { toggleOpenItem } from "@/lib/server/plans";
import { ErrorBanner } from "@/components/ui/error-banner";

/** Open items with a checkbox each (latest version only). Optimistic; reverts and announces on error. */
export function OpenItemsEditor({
  tripId,
  items,
  done: initial,
}: {
  tripId: string;
  items: Plan["openItems"];
  done: string[];
}) {
  const t = useTranslations("plan");
  const [done, setDone] = useState(new Set(initial));
  const [error, setError] = useState<ActionError | null>(null);
  const [, start] = useTransition();
  if (items.length === 0) return null;

  function toggle(key: string, next: boolean) {
    setError(null);
    setDone((d) => {
      const n = new Set(d);
      if (next) n.add(key);
      else n.delete(key);
      return n;
    });
    start(async () => {
      const r = await toggleOpenItem(tripId, key, next);
      if (!r.ok) {
        setError(r.error);
        setDone((d) => {
          const n = new Set(d);
          if (next) n.delete(key);
          else n.add(key);
          return n;
        });
      }
    });
  }

  return (
    <section aria-labelledby="plan-open" className="rounded-[14px] border border-line bg-card p-4 sm:p-5">
      <h3 id="plan-open" className="mb-1 text-base font-semibold">
        {t("openItems.title")}
      </h3>
      <ul className="text-sm">
        {items.map((it, i) => {
          const key = openItemKey(it.text);
          const isDone = done.has(key);
          return (
            <li key={i}>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-accent"
                  checked={isDone}
                  aria-label={isDone ? t("openItems.markOpen", { text: it.text }) : t("openItems.markDone", { text: it.text })}
                  onChange={(e) => toggle(key, e.target.checked)}
                />
                <span className={isDone ? "line-through" : ""}>
                  {it.text}
                  {it.day && <span className={mutedCls}> ({t("day", { n: it.day })})</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite" className="empty:hidden">
        <ErrorBanner error={error} />
      </div>
    </section>
  );
}
