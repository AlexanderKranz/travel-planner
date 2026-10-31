"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import { geocode } from "@/lib/geocode-client";
import { cleanAirportCity, pickHomeSuggestion, shouldSuggestHome, type HomeSuggestion, type SuggestionAirport } from "@/lib/home-suggestion";
import type { HomeLocation } from "./home-location-picker";

type Found = { code: string; value: HomeSuggestion | null };

async function lookupAirport(code: string, signal: AbortSignal): Promise<SuggestionAirport | null> {
  const res = await fetch(`/api/airports?q=${encodeURIComponent(code)}&limit=8`, { signal });
  if (!res.ok) return null;
  const body = (await res.json()) as { results?: (SuggestionAirport & { iata: string })[] };
  return body.results?.find((a) => a.iata === code) ?? null;
}

/**
 * One-tap suggestion of the first home airport's place as home location. Nothing is saved here: tapping only fills
 * the form (the user still has to save). Shown only while no home is set; follows airport changes without a reload.
 * Uses the same geocoding path as the picker, so the zone is validated; no zone found = no suggestion.
 */
export function HomeSuggestionButton({
  airports,
  home,
  onAccept,
}: {
  airports: string[];
  home: HomeLocation | null;
  onAccept: (v: HomeLocation) => void;
}) {
  const t = useTranslations("settings.home");
  const locale = useLocale();
  const [found, setFound] = useState<Found | null>(null);
  const first = airports[0];
  const wanted = shouldSuggestHome(home, airports);

  useEffect(() => {
    if (!wanted || !first) return;
    const controller = new AbortController();
    (async () => {
      try {
        const airport = await lookupAirport(first, controller.signal);
        if (!airport) return setFound({ code: first, value: null });
        const r = await geocode(cleanAirportCity(airport.city), locale, controller.signal);
        setFound({ code: first, value: r.unavailable || r.rateLimited ? null : pickHomeSuggestion(airport, r.results, locale) });
      } catch {
        // Aborted or offline: no suggestion.
      }
    })();
    return () => controller.abort();
  }, [wanted, first, locale]);

  const value = wanted && found?.code === first ? found.value : null;
  if (!value) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className={`min-w-0 break-words text-sm ${mutedCls}`}>{t("suggestHint")}</p>
      <button type="button" className={btnSecondary} onClick={() => onAccept(value)}>
        {t("suggestUse", { place: value.name })}
      </button>
    </div>
  );
}
