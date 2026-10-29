"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { TextField } from "@/components/ui/fields";
import { btnSecondary, errorCls, inputCls, mutedCls } from "@/components/ui/styles";
import { DEFAULT_RADIUS_KM, type GeoPlace } from "@/lib/domain";
import type { DestinationDraft } from "./trip-draft";

const RADII = [10, 25, 40, 60, 100];
const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

async function geocode(q: string, lang: string, signal: AbortSignal) {
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}&lang=${lang}`, { signal });
  if (res.status === 429) return { results: [], unavailable: false, rateLimited: true };
  if (!res.ok) throw new Error(String(res.status));
  const body = (await res.json()) as { results?: GeoPlace[]; error?: string };
  return {
    results: body.results ?? [],
    unavailable: body.error === "unavailable",
    rateLimited: body.error === "rate_limited",
  };
}

export function DestinationPicker({
  value,
  onChange,
  error,
  countryCodes,
}: {
  value: DestinationDraft;
  onChange: (v: DestinationDraft) => void;
  error?: string;
  countryCodes: string[];
}) {
  const t = useTranslations("trips.form.destination");
  const locale = useLocale();
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [active, setActive] = useState(-1);
  const q = query.trim();
  const searching = q.length >= MIN_CHARS;
  const open = value.mode === "none" && searching;
  const rows = results.length + 1; // last row = free text

  useEffect(() => {
    if (value.mode !== "none" || q.length < MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      geocode(q, locale, controller.signal)
        .then((r) => {
          setResults(r.results);
          setUnavailable(r.unavailable);
          setRateLimited(r.rateLimited);
          setSearched(true);
          setActive(-1);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setResults([]);
          setUnavailable(true);
          setRateLimited(false);
          setSearched(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, locale, value.mode]);

  function label(p: GeoPlace) {
    return [p.name, p.admin1, countryName(p.countryCode, locale)].filter(Boolean).join(", ");
  }

  function pickPlace(p: GeoPlace) {
    onChange({
      mode: "geo",
      geoKind: p.suggestedKind,
      geoId: p.geoId,
      placeName: p.name,
      placeLabel: label(p),
      name: p.name,
      radiusKm: null,
    });
    setQuery("");
    setResults([]);
    setSearched(false);
  }

  function pickFreeText() {
    onChange({ mode: "freetext", name: q, countryCode: "" });
    setQuery("");
    setResults([]);
    setSearched(false);
  }

  function reset() {
    onChange({ mode: "none" });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % rows);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? rows - 1 : a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const i = active >= 0 ? active : 0;
      if (i < results.length) pickPlace(results[i]);
      else pickFreeText();
    } else if (e.key === "Escape") {
      setQuery("");
      setResults([]);
    }
  }

  const legend = <legend className="mb-1 text-sm font-medium">{t("legend")}</legend>;

  if (value.mode === "geo") {
    const radius = value.radiusKm ?? DEFAULT_RADIUS_KM[value.geoKind];
    const radii = RADII.includes(radius) ? RADII : [...RADII, radius].sort((a, b) => a - b);
    return (
      <fieldset className="flex flex-col gap-3">
        {legend}
        <div className="flex items-center justify-between gap-2 rounded-md border border-line p-2 pl-3">
          <p className="min-w-0 text-sm">
            <span className={`block ${mutedCls}`}>{t("anchor")}</span>
            <strong className="break-words">{value.placeLabel}</strong>
          </p>
          <button type="button" className={btnSecondary} onClick={reset}>
            {t("change")}
          </button>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t("kind")}</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["city", "region"] as const).map((k) => (
              <label
                key={k}
                className="flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-line-strong px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
              >
                <input
                  type="radio"
                  name={`${id}-kind`}
                  className="sr-only"
                  checked={value.geoKind === k}
                  onChange={() => onChange({ ...value, geoKind: k, radiusKm: null })}
                />
                {t(k)}
              </label>
            ))}
          </div>
        </fieldset>
        {value.geoKind === "region" && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-radius`} className="text-sm font-medium">
              {t("radius")}
            </label>
            <select
              id={`${id}-radius`}
              className={inputCls}
              value={radius}
              onChange={(e) => onChange({ ...value, radiusKm: Number(e.target.value) })}
            >
              {radii.map((r) => (
                <option key={r} value={r}>
                  {t("radiusOption", { km: r })}
                </option>
              ))}
            </select>
            <p className={`text-sm ${mutedCls}`}>{t("radiusHint")}</p>
          </div>
        )}
        <TextField
          label={t("displayName")}
          hint={t("displayNameHint")}
          value={value.name}
          maxLength={120}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
        {error && <p className={errorCls}>{error}</p>}
      </fieldset>
    );
  }

  if (value.mode === "freetext") {
    return (
      <fieldset className="flex flex-col gap-3">
        {legend}
        <p className={`text-sm ${mutedCls}`}>{t("freeTextHint")}</p>
        <TextField
          label={t("displayName")}
          value={value.name}
          maxLength={120}
          required
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          error={error}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-country`} className="text-sm font-medium">
            {t("country")}
          </label>
          <select
            id={`${id}-country`}
            className={inputCls}
            value={value.countryCode}
            onChange={(e) => onChange({ ...value, countryCode: e.target.value })}
          >
            <option value="">{t("countryNone")}</option>
            {countryCodes.map((c) => ({ c, n: countryName(c, locale) ?? c }))
              .sort((a, b) => a.n.localeCompare(b.n, locale))
              .map(({ c, n }) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
          </select>
          <p className={`text-sm ${mutedCls}`}>{t("countryHint")}</p>
        </div>
        <div>
          <button type="button" className={btnSecondary} onClick={reset}>
            {t("searchInstead")}
          </button>
        </div>
      </fieldset>
    );
  }

  const status = loading
    ? t("searching")
    : searched && searching
      ? rateLimited
        ? t("rateLimited")
        : unavailable
        ? t("unavailable")
        : results.length === 0
          ? t("noResults")
          : t("resultCount", { count: results.length })
      : "";

  return (
    <fieldset className="flex flex-col gap-1">
      {legend}
      <label htmlFor={`${id}-input`} className="sr-only">
        {t("search")}
      </label>
      <div className="relative">
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
          aria-describedby={`${id}-hint${error ? ` ${id}-err` : ""}`}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          maxLength={80}
          placeholder={t("placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim().length < MIN_CHARS) {
              setResults([]);
              setSearched(false);
            }
          }}
          onKeyDown={onKeyDown}
          className={inputCls}
        />
        {open && (
          <ul
            id={`${id}-list`}
            role="listbox"
            aria-label={t("results")}
            className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line-strong bg-card shadow-lg"
          >
            {results.map((p, i) => (
              <li
                key={p.geoId}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickPlace(p)}
                className={`flex min-h-11 cursor-pointer items-center px-3 py-1 text-sm ${
                  i === active ? "bg-info-bg" : ""
                }`}
              >
                {label(p)}
              </li>
            ))}
            <li
              id={`${id}-opt-${results.length}`}
              role="option"
              aria-selected={active === results.length}
              onMouseDown={(e) => e.preventDefault()}
              onClick={pickFreeText}
              className={`flex min-h-11 cursor-pointer items-center border-t border-line px-3 py-1 text-sm ${
                active === results.length ? "bg-info-bg" : ""
              }`}
            >
              {t("useFreeText", { query: q })}
            </li>
          </ul>
        )}
      </div>
      <p id={`${id}-hint`} className={`text-sm ${mutedCls}`}>
        {t("searchHint")}
      </p>
      <p role="status" className="sr-only">
        {status}
      </p>
      {status && (
        <p aria-hidden="true" className={`text-sm ${mutedCls}`}>
          {status}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className={errorCls}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
