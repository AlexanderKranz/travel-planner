"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { AirportPicker } from "@/components/settings/airport-picker";
import { HomeLocationPicker, type HomeLocation } from "@/components/settings/home-location-picker";
import { monthName } from "@/components/trips/trip-title";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SelectField } from "@/components/ui/fields";
import { btnPrimary, linkCls, mutedCls } from "@/components/ui/styles";
import { Link, useRouter } from "@/i18n/navigation";
import type { DestinationSearchInput, DestinationSearchView, TravelMode } from "@/lib/domain/destination-search";
import type { ActionError } from "@/lib/domain/result";
import { DEFAULT_DRIVE_HOURS, DRIVE_LIMIT_OPTIONS } from "@/lib/drive/estimate";
import { MAX_ORIGINS } from "@/lib/flights/estimate";
import { defaultTravelMode, limitOptions } from "./helpers";

/** The profile home as the form needs it: `home` has coordinates (usable), `legacyHome` is a name saved before drive searches. */
export type DiscoverHome = { home: HomeLocation & { geoId: number } | null; legacyHome: boolean };

export type DiscoverPurposeOption = { id: string; name: string; /** Hours from the purpose's flight limit, null = none. */ maxFlightHours: number | null };

const chip =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-line-strong px-3 text-sm select-none has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";

const MAX_MONTHS = 3;

/**
 * The search form. Only the purpose is required (it is what the search starts from); months, group, airports and
 * the flight limit are optional and default to the profile and the purpose. One POST; the list page takes over, so
 * a slow search can be left without losing it.
 */
export function DiscoverForm({
  purposes,
  groups,
  homeAirports,
  home,
  legacyHome,
}: {
  purposes: DiscoverPurposeOption[];
  groups: { id: string; name: string }[];
  homeAirports: string[];
} & DiscoverHome) {
  const t = useTranslations("discover");
  const locale = useLocale();
  const f = useFormatter();
  const router = useRouter();
  const id = useId();
  const [purposeId, setPurposeId] = useState(purposes[0]?.id ?? "");
  const [months, setMonths] = useState<number[]>([]);
  const [groupId, setGroupId] = useState("");
  const [origins, setOrigins] = useState<string[]>(homeAirports.slice(0, MAX_ORIGINS));
  const purpose = purposes.find((p) => p.id === purposeId);
  const [limit, setLimit] = useState<number | null>(purposes[0]?.maxFlightHours ?? null);
  const [mode, setMode] = useState<TravelMode>(() => defaultTravelMode(homeAirports, home));
  const [driveHours, setDriveHours] = useState<number>(DEFAULT_DRIVE_HOURS);
  const [start, setStart] = useState<HomeLocation | null>(home);
  const [saveHome, setSaveHome] = useState(home === null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  if (purposes.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-[14px] border border-line bg-card p-4 sm:p-5">
        <p>{t("form.noPurpose")}</p>
        <Link href="/app/purposes/new" className={btnPrimary}>
          {t("form.createPurpose")}
        </Link>
      </div>
    );
  }

  const isDrive = mode === "drive";
  /** A start picked in this form that differs from the profile home applies to this search only, unless saved. */
  const startIsNew = start !== null && start.geoId !== undefined && start.geoId !== home?.geoId;
  const noAirports = origins.length === 0;
  const purposeHasLimit = (purpose?.maxFlightHours ?? null) !== null;
  const options = limitOptions(purpose?.maxFlightHours ?? null, limit);

  function toggleMonth(m: number) {
    setMonths((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : cur.length >= MAX_MONTHS ? cur : [...cur, m].sort((a, b) => a - b)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    // Only the active mode's fields are sent; the server refuses a mix.
    const common = { purposeId, months, groupId: groupId || null };
    const body: DestinationSearchInput = isDrive
      ? {
          ...common,
          travelMode: "drive",
          maxDriveHours: driveHours,
          ...(startIsNew ? { homeGeoId: start.geoId, saveHome } : {}),
        }
      : {
          ...common,
          travelMode: "flight",
          origins,
          // A limit without airports is ignored by the server; do not send one.
          maxFlightHours: noAirports ? null : limit,
        };
    try {
      const res = await fetch("/api/destination-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { search?: DestinationSearchView; error?: ActionError };
      if (res.ok && json.search) {
        // Done, saved or still running: the list page shows it and polls when needed.
        router.push(`/app/trips/discover/${json.search.id}`);
        return;
      }
      setError(json.error ?? "failed");
    } catch {
      setError("failed");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" aria-busy={pending}>
      <SelectField
        label={t("form.purpose")}
        hint={t("form.purposeHint")}
        value={purposeId}
        onChange={(e) => {
          setPurposeId(e.target.value);
          setLimit(purposes.find((p) => p.id === e.target.value)?.maxFlightHours ?? null);
        }}
        required
      >
        {purposes.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>

      <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-months-hint`}>
        <legend className="mb-1 text-sm font-medium">{t("form.months")}</legend>
        <p id={`${id}-months-hint`} className={`text-sm ${mutedCls}`}>
          {t("form.monthsHint")}
        </p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6" role="group" aria-label={t("form.monthsLabel")}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <label key={m} className={chip}>
              <input
                type="checkbox"
                className="sr-only"
                checked={months.includes(m)}
                disabled={!months.includes(m) && months.length >= MAX_MONTHS}
                onChange={() => toggleMonth(m)}
              />
              {monthName(m, locale)}
            </label>
          ))}
        </div>
      </fieldset>

      {groups.length > 0 && (
        <SelectField label={t("form.group")} hint={t("form.groupHint")} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">{t("form.groupNone")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </SelectField>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("form.travelMode")}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["flight", "drive"] as const).map((m) => (
            <label key={m} className={chip}>
              <input type="radio" className="sr-only" name={`${id}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} />
              {t(m === "flight" ? "form.modeFlight" : "form.modeDrive")}
            </label>
          ))}
        </div>
      </fieldset>

      {isDrive ? (
        <>
          <HomeLocationPicker
            value={start}
            onChange={setStart}
            label={t("form.start")}
            emptyLabel={legacyHome ? t("form.startRepick") : t("form.startNew")}
            clearLabel={t("form.startChange")}
            hint=""
          />
          {startIsNew && (
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input type="checkbox" className="size-5" checked={saveHome} onChange={(e) => setSaveHome(e.target.checked)} />
              {t("form.saveHome")}
            </label>
          )}
          <SelectField
            label={t("form.driveLimit")}
            hint={t("form.driveLimitHint")}
            value={String(driveHours)}
            onChange={(e) => setDriveHours(Number(e.target.value))}
          >
            {DRIVE_LIMIT_OPTIONS.map((h) => (
              <option key={h} value={String(h)}>
                {t("form.driveLimitHours", { hours: f.number(h, { maximumFractionDigits: 1 }) })}
              </option>
            ))}
          </SelectField>
        </>
      ) : (
        <>
        <AirportPicker value={origins} onChange={(c) => setOrigins(c.slice(0, MAX_ORIGINS))} max={MAX_ORIGINS} label={t("form.airports")} hint={t("form.airportsHint")} />

        <div className="flex flex-col gap-1">
          <SelectField
            label={t("form.flightLimit")}
            hint={t("form.flightLimitHint")}
            value={limit === null ? "" : String(limit)}
            onChange={(e) => setLimit(e.target.value === "" ? null : Number(e.target.value))}
            disabled={noAirports}
          >
            <option value="">{t("form.flightLimitNone")}</option>
            {options.map((h) => (
              <option key={h} value={String(h)}>
                {t("form.flightLimitHours", { hours: f.number(h, { maximumFractionDigits: 1 }) })}
              </option>
            ))}
          </SelectField>
          {noAirports && purposeHasLimit && (
            <p role="note" className="text-sm font-medium">
              {t("form.noAirportForLimit")}{" "}
              <Link href="/settings" className={linkCls}>
                {t("form.toSettings")}
              </Link>
            </p>
          )}
        </div>
        </>
      )}

      <ErrorBanner error={error} />
      <div role="status" aria-live="polite" className="text-sm">
        {pending && (
          <p className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-block size-5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-transparent motion-reduce:animate-none"
            />
            <span>{t("running.ideas")}</span>
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="submit" className={btnPrimary} disabled={pending || !purposeId || (isDrive && !start)}>
          {pending ? t("form.submitting") : t("form.submit")}
        </button>
      </div>
    </form>
  );
}
