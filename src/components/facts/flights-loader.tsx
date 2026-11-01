"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { Fact, FlightsFacts } from "@/lib/domain";
import { btnSecondary, cardCls, mutedCls } from "@/components/ui/styles";
import { FactSkeleton } from "./fact-skeleton";
import { FlightsPanel } from "./flights-panel";
import { SourceNote } from "./source-note";

type State = { kind: "loading" } | { kind: "done"; fact: Fact<FlightsFacts> } | { kind: "error"; limited: boolean };

/** Loads /api/trips/[id]/flights on the client so the trip page never waits for the schedule lookups. */
export function FlightsLoader({ tripId, locale, adults, searchId }: { tripId: string; locale: "de" | "en"; adults: number; searchId?: string }) {
  const t = useTranslations("facts.flights");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/flights?locale=${encodeURIComponent(locale)}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok) {
          if (!ctrl.signal.aborted) setState({ kind: "error", limited: res.status === 429 });
          return;
        }
        const fact = (await res.json()) as Fact<FlightsFacts>;
        if (!ctrl.signal.aborted) setState({ kind: "done", fact });
      } catch {
        if (!ctrl.signal.aborted) setState({ kind: "error", limited: false });
      }
    })();
    return () => ctrl.abort();
  }, [tripId, locale, attempt]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  if (state.kind === "done") return <FlightsPanel fact={state.fact} tripId={tripId} adults={adults} locale={locale} searchId={searchId} />;

  return (
    <section aria-label={t("title")} className={`${cardCls} min-w-0`}>
      <h2 className="mb-3 text-lg font-bold">{t("title")}</h2>
      {state.kind === "loading" ? (
        <>
          <FactSkeleton />
          <p role="status" className={`mt-3 text-sm ${mutedCls}`}>{t("loading")}</p>
        </>
      ) : (
        <>
          <p role="alert" className="text-sm">{state.limited ? t("rateLimited") : t("unavailable.provider_error")}</p>
          <p className="mt-3">
            <button type="button" onClick={retry} className={btnSecondary}>
              {t("retry")}
            </button>
          </p>
          <SourceNote source="aerodatabox" />
        </>
      )}
    </section>
  );
}
