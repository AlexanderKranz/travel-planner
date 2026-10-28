"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Fact, PlacesFacts } from "@/lib/domain";
import { btnSecondary, cardCls, mutedCls } from "@/components/ui/styles";
import { FactPanel } from "./fact-panel";
import { FactSkeleton } from "./fact-skeleton";
import { FactUnavailable } from "./fact-unavailable";
import { PlacesList } from "./places-list";
import { SourceNote } from "./source-note";

type State = { kind: "loading" } | { kind: "done"; fact: Fact<PlacesFacts> } | { kind: "error" };

/** Silent follow-up requests while the server could not finish all interests within one request. */
const MAX_AUTO_FOLLOWUPS = 3;

const pending = (fact: Fact<PlacesFacts>) =>
  fact.status === "ok" ? fact.data.groups.filter((g) => g.status === "error").length : 0;

/**
 * Loads places from /api/trips/[id]/places so the trip page never waits for Overpass (queries take minutes).
 * Cached interests come back instantly; if some interests are still missing, the next request fetches them.
 */
export function PlacesLoader({ tripId, locale }: { tripId: string; locale: string }) {
  const t = useTranslations("facts.places");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const followups = useRef(0);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/places?locale=${encodeURIComponent(locale)}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fact = (await res.json()) as Fact<PlacesFacts>;
        if (ctrl.signal.aborted) return;
        setState({ kind: "done", fact });
        // Show what we have, then continue silently for interests that did not fit into this request.
        if (pending(fact) > 0 && followups.current < MAX_AUTO_FOLLOWUPS) {
          followups.current += 1;
          setAttempt((n) => n + 1);
        }
      } catch {
        if (!ctrl.signal.aborted) setState({ kind: "error" });
      }
    })();
    return () => ctrl.abort();
  }, [tripId, locale, attempt]);

  const retry = useCallback(() => {
    followups.current = 0;
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  if (state.kind === "loading") {
    return (
      <section aria-label={t("title")} className={`${cardCls} min-w-0`}>
        <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
        <FactSkeleton />
        <p className={`mt-3 text-sm ${mutedCls}`}>{t("loading")}</p>
      </section>
    );
  }

  const fact: Fact<PlacesFacts> =
    state.kind === "error" ? { status: "unavailable", reason: "provider_error", source: "osm" } : state.fact;
  const stillMissing = pending(fact) > 0;
  const autoContinuing = stillMissing && followups.current < MAX_AUTO_FOLLOWUPS;

  if (fact.status !== "ok") {
    return (
      <section aria-label={t("title")} className={`${cardCls} min-w-0`}>
        <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
        <FactUnavailable fact={fact} />
        <p className="mt-3">
          <button type="button" onClick={retry} className={btnSecondary}>
            {t("retry")}
          </button>
        </p>
        <SourceNote source={fact.source ?? "osm"} />
      </section>
    );
  }

  return (
    <FactPanel
      title={t("title")}
      fact={fact}
      fallbackSource="osm"
      extraNote={
        stillMissing ? (
          autoContinuing ? (
            <span role="status">{t("loadingMore")}</span>
          ) : (
            <button type="button" onClick={retry} className={btnSecondary}>
              {t("retry")}
            </button>
          )
        ) : undefined
      }
    >
      {(data) => <PlacesList data={data} locale={locale} />}
    </FactPanel>
  );
}
