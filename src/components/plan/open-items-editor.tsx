"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { btnSecondary, inputCls, linkCls, mutedCls } from "@/components/ui/styles";
import type { ActionError } from "@/lib/domain";
import { MAX_OPEN_ITEMS, type Plan, type PlanEdit } from "@/lib/domain/plan";
import { useRouter } from "@/i18n/navigation";
import { openItemKey } from "@/lib/plan/open-items";
import { editPlan, toggleOpenItem } from "@/lib/server/plans";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { ActEditCtx } from "./act-edit";
import { asPlanError } from "./helpers";

const MAX_TEXT = 160;
const smallBtn = `${linkCls} inline-flex min-h-11 items-center px-1 text-sm`;

/**
 * Open items of the latest version: a checkbox each (optimistic; reverts and announces on error), plus add, change
 * and delete. Those save a code-only plan version like the activity edits; `edit` is undefined while a generation runs.
 */
export function OpenItemsEditor({
  tripId,
  items,
  done: initial,
  edit,
}: {
  tripId: string;
  items: Plan["openItems"];
  done: string[];
  edit?: ActEditCtx;
}) {
  const t = useTranslations("plan");
  const router = useRouter();
  const [done, setDone] = useState(new Set(initial));
  const [error, setError] = useState<ActionError | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  const [saving, startSave] = useTransition();
  const [, start] = useTransition();
  if (items.length === 0 && !edit) return null;

  function setKey(key: string, on: boolean) {
    setDone((d) => {
      const n = new Set(d);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  }

  function toggle(key: string, next: boolean) {
    setError(null);
    setKey(key, next);
    start(async () => {
      const r = await toggleOpenItem(tripId, key, next);
      if (!r.ok) {
        setError(r.error);
        setKey(key, !next);
      }
    });
  }

  function save(e: PlanEdit, onDone: () => void) {
    if (!edit) return;
    setError(null);
    startSave(async () => {
      const r = await editPlan(tripId, edit.baseVersion, e);
      if (!r.ok) {
        setError(asPlanError(r.error));
        return;
      }
      // The check mark hangs on the text: a reworded item keeps it.
      if (e.kind === "open_set" && done.has(openItemKey(items[e.i].text))) {
        const key = openItemKey(e.text);
        setKey(key, true);
        await toggleOpenItem(tripId, key, true);
      }
      onDone();
      router.refresh();
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
          if (editing?.i === i) {
            return (
              <li key={key}>
                <form
                  className="flex flex-wrap items-center gap-2 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save({ kind: "open_set", i, text: editing.text }, () => setEditing(null));
                  }}
                >
                  <input
                    className={`${inputCls} min-w-0 flex-1 basis-48`}
                    aria-label={t("openItems.editLabel", { text: it.text })}
                    maxLength={MAX_TEXT}
                    required
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ i, text: e.target.value })}
                  />
                  <button type="submit" className={btnSecondary} disabled={saving || !editing.text.trim()}>
                    {t("openItems.save")}
                  </button>
                  <button type="button" className={smallBtn} onClick={() => setEditing(null)}>
                    {t("openItems.cancel")}
                  </button>
                </form>
              </li>
            );
          }
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-2">
              <label className="flex min-h-11 min-w-0 flex-1 basis-48 items-center gap-3">
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
              {edit && (
                <span className="ml-8 flex gap-2 sm:ml-0">
                  <button
                    type="button"
                    className={smallBtn}
                    disabled={saving}
                    aria-label={t("openItems.editLabel", { text: it.text })}
                    onClick={() => setEditing({ i, text: it.text })}
                  >
                    {t("openItems.edit")}
                  </button>
                  <button
                    type="button"
                    className={smallBtn}
                    disabled={saving}
                    aria-label={t("openItems.deleteLabel", { text: it.text })}
                    onClick={() => save({ kind: "open_remove", i }, () => setEditing(null))}
                  >
                    {t("openItems.delete")}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {edit && items.length < MAX_OPEN_ITEMS && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save({ kind: "open_add", text: draft }, () => setDraft(""));
          }}
        >
          <input
            className={`${inputCls} min-w-0 flex-1 basis-48`}
            aria-label={t("openItems.addLabel")}
            placeholder={t("openItems.addLabel")}
            maxLength={MAX_TEXT}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className={btnSecondary} disabled={saving || !draft.trim()}>
            {t("openItems.add")}
          </button>
        </form>
      )}
      <div aria-live="polite" className="empty:hidden">
        <ErrorBanner error={error} />
      </div>
    </section>
  );
}
