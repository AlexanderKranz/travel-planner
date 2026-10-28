"use client";

import { useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { btnPrimary, btnSecondary, cardCls, focusCls, inputCls, mutedCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { PLAN_CHIPS, type PlanChip } from "@/lib/domain/plan";
import { editPlan } from "@/lib/server/plans";
import { asPlanError, range, toggleIn } from "./helpers";
import { PlanErrorBanner } from "./plan-runner";

export type IterateBlock = null | "notLatest" | "busy" | "aiDisabled" | "budget" | "outdated";

const MAX_TEXT = 500;

function Toggle({
  pressed,
  onClick,
  children,
  disabled,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-11 items-center justify-center rounded-full border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${focusCls} ${
        pressed
          ? "border-blue-700 bg-blue-700 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-neutral-950"
          : "border-neutral-400 hover:bg-neutral-100 dark:border-neutral-500 dark:hover:bg-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}

export function PlanIterate({
  tripId,
  locale,
  baseVersion,
  dayCount,
  bestDay,
  aiBlock,
  editBlock,
}: {
  tripId: string;
  locale: string;
  baseVersion: number;
  dayCount: number;
  bestDay: number | null;
  /** Why chips + free text are disabled (null = usable). */
  aiBlock: IterateBlock;
  /** Why code-only edits are disabled (null = usable). */
  editBlock: IterateBlock;
}) {
  const t = useTranslations("plan.iterate");
  const router = useRouter();
  const uid = useId();
  const [chips, setChips] = useState<PlanChip[]>([]);
  const [days, setDays] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [swapA, setSwapA] = useState(1);
  const [swapB, setSwapB] = useState(Math.min(2, dayCount));
  const [bestSel, setBestSel] = useState<string>(bestDay ? String(bestDay) : "");
  const [pending, start] = useTransition();

  const needsDay = chips.includes("redo_day") && days.length === 0;
  const empty = chips.length === 0 && text.trim() === "";
  const aiOff = aiBlock !== null;
  const canApply = !aiOff && !running && !empty && !needsDay;
  const dayList = range(dayCount);

  async function apply() {
    setError(null);
    setReply(null);
    setRunning(true);
    try {
      const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/plan/iterate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locale,
          baseVersion,
          feedback: { chips, days, ...(text.trim() ? { text: text.trim() } : {}) },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; reply?: string; unchanged?: boolean };
      if (!res.ok) {
        setError(asPlanError(json.error));
        return;
      }
      setReply(json.unchanged ? t("noChange") : (json.reply ?? t("done")));
      setChips([]);
      setDays([]);
      setText("");
      router.refresh();
    } catch {
      setError("ai_unavailable");
    } finally {
      setRunning(false);
    }
  }

  function edit(e: Parameters<typeof editPlan>[2]) {
    setError(null);
    setReply(null);
    start(async () => {
      const r = await editPlan(tripId, baseVersion, e);
      if (r.ok) {
        setReply(t("saved"));
        router.refresh();
      } else setError(asPlanError(r.error));
    });
  }

  return (
    <section aria-labelledby={`${uid}-h`} className={`${cardCls} flex min-w-0 flex-col gap-4`}>
      <h2 id={`${uid}-h`} className="text-lg font-bold">
        {t("title")}
      </h2>

      {aiBlock && (
        <p role="note" className="rounded-md bg-neutral-100 p-2.5 text-sm dark:bg-neutral-800">
          {t(`blocked.${aiBlock}`)}
        </p>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canApply) void apply();
        }}
      >
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-sm font-medium">{t("chipsLabel")}</legend>
          <div className="flex flex-wrap gap-2">
            {PLAN_CHIPS.map((c) => (
              <Toggle key={c} pressed={chips.includes(c)} disabled={aiOff} onClick={() => setChips((l) => toggleIn(l, c, 4))}>
                {t(`chips.${c}`)}
              </Toggle>
            ))}
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-sm font-medium">{t("scopeLabel")}</legend>
          <p id={`${uid}-scope`} className={`mb-1.5 text-xs ${mutedCls}`}>
            {t("scopeHint")}
          </p>
          <div className="flex flex-wrap gap-2" aria-describedby={`${uid}-scope`}>
            {dayList.map((n) => (
              <Toggle key={n} pressed={days.includes(n)} disabled={aiOff} onClick={() => setDays((l) => toggleIn(l, n, 7))}>
                <span className="sr-only">{t("dayWord")} </span>
                {n}
              </Toggle>
            ))}
          </div>
          {needsDay && (
            <p role="alert" className="mt-1.5 text-sm text-red-700 dark:text-red-400">
              {t("redoNeedsDay")}
            </p>
          )}
        </fieldset>

        <div>
          <label htmlFor={`${uid}-text`} className="mb-1.5 block text-sm font-medium">
            {t("textLabel")}
          </label>
          <textarea
            id={`${uid}-text`}
            className={`${inputCls} min-h-24`}
            rows={3}
            maxLength={MAX_TEXT}
            value={text}
            disabled={aiOff}
            placeholder={t("textPlaceholder")}
            onChange={(e) => setText(e.target.value)}
          />
          <p className={`mt-1 text-right text-xs ${mutedCls}`} aria-hidden="true">
            {text.length}/{MAX_TEXT}
          </p>
        </div>

        <button type="submit" className={btnPrimary} disabled={!canApply} aria-busy={running}>
          {running ? t("applying") : t("apply")}
        </button>
      </form>

      <div role="status" aria-live="polite" className="text-sm">
        {running && <p>{t("applyingHint")}</p>}
        {reply && (
          <p className="rounded-md border border-blue-600 bg-blue-50 p-2.5 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100">
            {reply}
          </p>
        )}
      </div>
      <PlanErrorBanner error={error} />

      <div className="flex flex-col gap-3 border-t border-neutral-300 pt-4 dark:border-neutral-700">
        <h3 className="text-base font-semibold">{t("edit.title")}</h3>
        <p className={`text-xs ${mutedCls}`}>{t("edit.hint")}</p>
        {editBlock && (
          <p role="note" className="text-sm">
            {t(`blocked.${editBlock}`)}
          </p>
        )}
        <fieldset className="flex flex-wrap items-end gap-2" disabled={editBlock !== null || pending}>
          <legend className="mb-1.5 text-sm font-medium">{t("swap.title")}</legend>
          <div>
            <label htmlFor={`${uid}-a`} className="mb-1 block text-xs">
              {t("swap.a")}
            </label>
            <select id={`${uid}-a`} className={`${inputCls} w-24`} value={swapA} onChange={(e) => setSwapA(Number(e.target.value))}>
              {dayList.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-b`} className="mb-1 block text-xs">
              {t("swap.b")}
            </label>
            <select id={`${uid}-b`} className={`${inputCls} w-24`} value={swapB} onChange={(e) => setSwapB(Number(e.target.value))}>
              {dayList.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={btnSecondary}
            disabled={swapA === swapB}
            onClick={() => edit({ kind: "swap_days", a: swapA, b: swapB })}
          >
            {t("swap.apply")}
          </button>
        </fieldset>
        <fieldset className="flex flex-wrap items-end gap-2" disabled={editBlock !== null || pending}>
          <legend className="mb-1.5 text-sm font-medium">{t("best.title")}</legend>
          <div>
            <label htmlFor={`${uid}-best`} className="mb-1 block text-xs">
              {t("best.label")}
            </label>
            <select id={`${uid}-best`} className={`${inputCls} w-36`} value={bestSel} onChange={(e) => setBestSel(e.target.value)}>
              <option value="">{t("best.none")}</option>
              {dayList.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={btnSecondary}
            disabled={bestSel === (bestDay ? String(bestDay) : "")}
            onClick={() => edit({ kind: "set_best", n: bestSel ? Number(bestSel) : null })}
          >
            {t("best.apply")}
          </button>
        </fieldset>
      </div>
    </section>
  );
}
