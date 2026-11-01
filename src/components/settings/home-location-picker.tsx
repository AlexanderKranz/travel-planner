"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { btnSecondary, errorCls, inputCls, mutedCls } from "@/components/ui/styles";
import type { GeoPlace } from "@/lib/domain";
import { geocode, placeLabel } from "@/lib/geocode-client";

/** `geoId` is the GeoNames id of the picked place; the server resolves the coordinates from it. Absent on a home saved before drive searches. */
export type HomeLocation = { name: string; timezone: string; geoId?: number };

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

/** Optional home place (for the time difference). Reuses the destination search; only places with a time zone. */
export function HomeLocationPicker({
  value,
  onChange,
  error,
  label,
  emptyLabel,
  emptyNote,
  clearLabel,
  hint,
}: {
  value: HomeLocation | null;
  onChange: (v: HomeLocation | null) => void;
  error?: string;
  /** Overrides for the drive search form (an empty `hint` hides the hint line). Without `emptyLabel` the settings texts apply, including the "Germany" default (about time zones). */
  label?: string;
  emptyLabel?: string;
  emptyNote?: string;
  clearLabel?: string;
  hint?: string;
}) {
  const t = useTranslations("settings.home");
  const locale = useLocale();
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "done" | "unavailable">("idle");
  const [active, setActive] = useState(-1);
  const q = query.trim();
  const searching = q.length >= MIN_CHARS;
  const open = searching && state === "done" && results.length > 0;

  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState("loading");
      geocode(q, locale, controller.signal)
        .then((r) => {
          setResults(r.results.filter((p) => p.timezone));
          setState(r.unavailable || r.rateLimited ? "unavailable" : "done");
          setActive(-1);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setResults([]);
          setState("unavailable");
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, searching, locale]);

  function pick(p: GeoPlace) {
    if (!p.timezone) return;
    onChange({ name: placeLabel(p, locale), timezone: p.timezone, geoId: p.geoId });
    setQuery("");
    setResults([]);
    setState("idle");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? results.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[active >= 0 ? active : 0]);
    } else if (e.key === "Escape") {
      setQuery("");
      setResults([]);
    }
  }

  const hintText = hint ?? t("hint");
  const status =
    state === "loading"
      ? t("searching")
      : state === "unavailable"
        ? t("unavailable")
        : searching && state === "done" && results.length === 0
          ? t("noResults")
          : "";

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{label ?? t("label")}</legend>
      <div className="flex items-center justify-between gap-2 rounded-md border border-line p-2 pl-3">
        <p className="min-w-0 break-words text-sm">
          <strong>{value ? value.name : (emptyLabel ?? t("default"))}</strong>
          {!value && (emptyLabel === undefined || emptyNote) && <span className={`block ${mutedCls}`}>{emptyNote ?? t("defaultNote")}</span>}
        </p>
        {value && (
          <button type="button" className={btnSecondary} onClick={() => onChange(null)}>
            {clearLabel ?? t("clear")}
          </button>
        )}
      </div>
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
          aria-describedby={[hintText ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          maxLength={80}
          placeholder={t("placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Results of the previous query must not stay selectable until the debounce fires.
            if (e.target.value.trim() !== q) {
              setResults([]);
              setActive(-1);
              setState("idle");
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
                onClick={() => pick(p)}
                className={`flex min-h-11 cursor-pointer items-center px-3 py-1 text-sm ${i === active ? "bg-info-bg" : ""}`}
              >
                {placeLabel(p, locale)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {hintText && (
        <p id={`${id}-hint`} className={`text-sm ${mutedCls}`}>
          {hintText}
        </p>
      )}
      <p role="status" className={`text-sm ${mutedCls}`}>
        {status}
      </p>
      {error && <p id={`${id}-error`} className={errorCls}>{error}</p>}
    </fieldset>
  );
}
