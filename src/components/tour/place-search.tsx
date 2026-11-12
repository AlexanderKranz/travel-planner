"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { mutedCls } from "@/components/ui/styles";
import type { TourSuggestion } from "@/lib/domain/tour";
import { PLACE_SEARCH_DEBOUNCE_MS, PLACE_SEARCH_MIN_CHARS, searchPlaces } from "@/lib/tour/search-client";
import { SearchCombobox } from "./search-combobox";

type Props = {
  label: string;
  /** Search centre (the city, else the first place); null = the field is disabled with a hint. */
  centre: { lat: number; lon: number } | null;
  isTaken: (key: string) => boolean;
  onPick: (s: TourSuggestion) => void;
  disabled?: boolean;
  /** `endpoint`: start or end of the tour, addresses and hotels allowed; default: sights only. */
  use?: "place" | "endpoint";
};

/** Place search (spec 3.1 source 2): Geoapify Autocomplete through /api/places/search, 400 ms, at least 3 characters. */
export function PlaceSearch({ label, centre, isTaken, onPick, disabled, use = "place" }: Props) {
  const t = useTranslations("tours");
  const locale = useLocale();
  const lat = centre?.lat;
  const lon = centre?.lon;
  const search = useCallback(
    (q: string, signal: AbortSignal) => searchPlaces(q, { lat: lat ?? 0, lon: lon ?? 0 }, locale, signal, use),
    [lat, lon, locale, use],
  );
  if (!centre) return <p className={`text-sm ${mutedCls}`}>{t("placesNeedCity")}</p>;
  return (
    <SearchCombobox<TourSuggestion>
      label={label}
      placeholder={t("placesPlaceholder")}
      hint={t("placesHint")}
      minChars={PLACE_SEARCH_MIN_CHARS}
      debounceMs={PLACE_SEARCH_DEBOUNCE_MS}
      search={search}
      disabled={disabled}
      itemKey={(s) => s.key}
      isDisabled={(s) => isTaken(s.key)}
      renderItem={(s) => (
        <span className="flex min-w-0 flex-col">
          <span className="break-words font-medium">{s.name}</span>
          <span className={`break-words text-xs ${mutedCls}`}>
            {[s.address, isTaken(s.key) ? t("inTour") : null].filter(Boolean).join(" · ")}
          </span>
        </span>
      )}
      onPick={onPick}
      texts={{
        searching: t("searching"),
        noResults: t("noResults"),
        count: (n) => t("resultCount", { count: n }),
        results: t("searchResults"),
        status: { unavailable: t("searchUnavailable"), rate_limited: t("searchRateLimited"), daily_limit: t("searchDailyLimit") },
      }}
    />
  );
}
