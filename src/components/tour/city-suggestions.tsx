"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { mutedCls } from "@/components/ui/styles";
import type { TourSuggestion } from "@/lib/domain/tour";
import { tourSuggestions } from "@/lib/server/tours";

type State = { status: "idle" | "loading" | "done" | "failed"; items: TourSuggestion[]; pending: boolean };

/**
 * "Vorschläge in Wien" (spec 2.1, 3.1 source 1): verified city places from the cache, collapsed. Loaded when first
 * opened (usually 0 external calls); "werden geladen" while the place retry job still has to fetch them.
 */
export function CitySuggestions({
  city,
  tripId,
  isTaken,
  canAdd,
  onPick,
}: {
  city: { key: string; name: string };
  tripId?: string;
  isTaken: (key: string) => boolean;
  canAdd: boolean;
  onPick: (s: TourSuggestion) => void;
}) {
  const t = useTranslations("tours");
  const [state, setState] = useState<State>({ status: "idle", items: [], pending: false });

  async function load() {
    setState((s) => ({ ...s, status: "loading" }));
    const r = await tourSuggestions({ city: city.key, ...(tripId ? { tripId } : {}) }).catch(() => null);
    if (!r?.ok) setState({ status: "failed", items: [], pending: false });
    else setState({ status: "done", items: r.data.suggestions, pending: r.data.pending });
  }

  return (
    <details
      className="rounded-lg border border-line"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state.status === "idle") void load();
      }}
    >
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">{t("suggestions", { city: city.name })}</summary>
      <div className="flex flex-col gap-2 px-3 pb-3">
        {state.status === "loading" && <p className={`text-sm ${mutedCls}`}>{t("searching")}</p>}
        {state.status === "failed" && (
          <p className={`text-sm ${mutedCls}`} role="status">
            {t("suggestionsFailed")}
          </p>
        )}
        {state.status === "done" && state.pending && (
          <p className={`text-sm ${mutedCls}`} role="status">
            {t("suggestionsLoading", { city: city.name })}
          </p>
        )}
        {state.status === "done" && !state.pending && state.items.length === 0 && (
          <p className={`text-sm ${mutedCls}`}>{t("suggestionsEmpty")}</p>
        )}
        {state.items.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {state.items.map((s) => {
              const taken = isTaken(s.key);
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    disabled={taken || !canAdd}
                    aria-label={t("addPlace", { name: s.name })}
                    onClick={() => onPick(s)}
                    className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-3 text-left text-sm hover:bg-hover disabled:opacity-50"
                  >
                    {taken ? s.name : `+ ${s.name}`}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
