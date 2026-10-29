"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { btnDanger, btnSecondary, focusCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import type { PlanEdit } from "@/lib/domain/plan";
import type { ActAddress } from "@/lib/plan/edit";
import { editPlan } from "@/lib/server/plans";
import { asPlanError, DAY_ACTION_HOVER, QUICK_ADD_HOVER } from "./helpers";

/** Owner's latest version, not busy: activity edits without AI (spec patch-safety [D7]). */
export type ActEditCtx = { tripId: string; baseVersion: number };

function useEdit(ctx: ActEditCtx) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<ActionError | null>(null);
  const run = (e: PlanEdit, onDone?: () => void) => {
    setError(null);
    start(async () => {
      const r = await editPlan(ctx.tripId, ctx.baseVersion, e);
      if (r.ok) {
        onDone?.();
        router.refresh();
      } else setError(asPlanError(r.error));
    });
  };
  return { pending, error, run };
}

function EditError({ error }: { error: ActionError | null }) {
  const t = useTranslations("plan.errors");
  if (!error) return null;
  return (
    <span role="alert" className="ml-1 text-xs text-danger">
      {t(error)}
    </span>
  );
}

const smallIcon = `${focusCls} inline-flex h-6 min-w-6 items-center justify-center rounded align-middle text-sm leading-none text-subtle hover:bg-hover hover:text-heading disabled:opacity-50`;

/** "↑" (make main place) and "×" (remove) after one alternative in "or: X · Y". */
export function AltEditButtons({ ctx, at, alt, name }: { ctx: ActEditCtx; at: ActAddress; alt: string; name: string }) {
  const t = useTranslations("plan.actEdit");
  const { pending, error, run } = useEdit(ctx);
  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        className={`${smallIcon} ${QUICK_ADD_HOVER}`}
        aria-label={t("promoteAlt", { name })}
        title={t("promoteAlt", { name })}
        disabled={pending}
        onClick={() => run({ kind: "promote_alt", ...at, alt })}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        className={`${smallIcon} ${QUICK_ADD_HOVER}`}
        aria-label={t("removeAlt", { name })}
        title={t("removeAlt", { name })}
        disabled={pending}
        onClick={() => run({ kind: "remove_alt", ...at, alt })}
      >
        <span aria-hidden="true">×</span>
      </button>
      <EditError error={error} />
    </span>
  );
}

/**
 * One activity row with an action column on the right (quick add "+" and remove "×"), reserved so the text never
 * reflows: stacked on phones, side by side from `sm`. Removing asks for an inline confirmation below the text.
 */
export function EditableActRow({
  ctx,
  at,
  name,
  add,
  children,
}: {
  ctx: ActEditCtx;
  at: ActAddress;
  /** Accessible name of the activity (place name or text). */
  name: string;
  add: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useTranslations("plan.actEdit");
  const { pending, error, run } = useEdit(ctx);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="group/act grid min-w-0 grid-cols-[minmax(0,1fr)_2.75rem] items-start gap-x-1 sm:grid-cols-[minmax(0,1fr)_5.5rem]">
      {children}
      <div className="-my-2.5 flex flex-col items-end sm:flex-row sm:justify-end">
        {add}
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={t("removeAct", { name })}
          aria-expanded={confirming}
          title={t("removeAct", { name })}
          disabled={pending}
          className={`${focusCls} inline-flex size-11 items-center justify-center rounded-md text-lg leading-none text-subtle hover:bg-hover hover:text-danger disabled:opacity-50 ${confirming ? "" : QUICK_ADD_HOVER}`}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {confirming && (
        <div role="group" aria-label={t("removeAct", { name })} className="col-span-2 mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-sunken p-2.5 text-sm">
          <span className="min-w-0 flex-1 basis-48">{t("confirm")}</span>
          <button
            type="button"
            className={`${btnDanger} px-4`}
            disabled={pending}
            aria-busy={pending}
            onClick={() => run({ kind: "remove_act", ...at }, () => setConfirming(false))}
          >
            {pending ? t("working") : t("confirmYes")}
          </button>
          <button type="button" className={`${btnSecondary} px-4`} autoFocus disabled={pending} onClick={() => setConfirming(false)}>
            {t("cancel")}
          </button>
          <EditError error={error} />
        </div>
      )}
    </li>
  );
}

/** Toggles the user's best-day marker (patch-safety [D8]); at most one best day, set only by the user. */
export function BestDayButton({ ctx, n, isBest }: { ctx: ActEditCtx; n: number; isBest: boolean }) {
  const t = useTranslations("plan.actEdit");
  const { pending, error, run } = useEdit(ctx);
  const label = isBest ? t("unmarkBest", { n }) : t("markBest", { n });
  return (
    <span className="-my-1.5 flex shrink-0 flex-col items-end">
      <button
        type="button"
        onClick={() => run({ kind: "set_best", n: isBest ? null : n })}
        aria-label={label}
        title={label}
        disabled={pending}
        className={`${focusCls} inline-flex size-11 items-center justify-center rounded-md text-xl leading-none hover:bg-hover disabled:opacity-50 ${
          isBest ? "text-accent-text" : `text-subtle hover:text-accent-text ${DAY_ACTION_HOVER}`
        }`}
      >
        <span aria-hidden="true">{isBest ? "★" : "☆"}</span>
      </button>
      <EditError error={error} />
    </span>
  );
}
