"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import type { GeoPlace } from "@/lib/domain";
import { geocode, placeLabel } from "@/lib/geocode-client";
import type { FormPoint } from "@/lib/tour/ui";
import { SearchCombobox, type SearchAnswer } from "./search-combobox";

/** City of a tour (spec 2.1): the trip form's Open-Meteo search (`/api/geocode`); stored as `geo:<GeoNames id>`. */
export function CityField({ value, onChange }: { value: FormPoint | null; onChange: (p: FormPoint | null) => void }) {
  const t = useTranslations("tours");
  const locale = useLocale();
  const search = useCallback(
    async (q: string, signal: AbortSignal): Promise<SearchAnswer<GeoPlace>> => {
      const r = await geocode(q, locale, signal);
      return { items: r.results, status: r.rateLimited ? "rate_limited" : r.unavailable ? "unavailable" : "ok" };
    },
    [locale],
  );

  if (value) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t("city")}</p>
        <div className="flex items-center justify-between gap-2 rounded-md border border-line p-2 pl-3">
          <strong className="min-w-0 break-words" data-testid="tour-city">
            {value.name}
          </strong>
          <button type="button" className={btnSecondary} onClick={() => onChange(null)}>
            {t("cityChange")}
          </button>
        </div>
        <p className={`text-sm ${mutedCls}`}>{t("cityHint")}</p>
      </div>
    );
  }

  return (
    <SearchCombobox<GeoPlace>
      label={t("city")}
      placeholder={t("cityPlaceholder")}
      hint={t("cityHint")}
      minChars={2}
      debounceMs={300}
      search={search}
      itemKey={(p) => String(p.geoId)}
      renderItem={(p) => placeLabel(p, locale)}
      onPick={(p) => onChange({ key: `geo:${p.geoId}`, name: p.name, lat: p.lat, lon: p.lon, source: "geonames" })}
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
