"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { inputCls, btnIcon, btnSecondary, mutedCls } from "@/components/ui/styles";
import { MAX_HOME_AIRPORTS } from "@/lib/domain";

type Airport = { iata: string; name: string; city: string; country: string };

async function search(q: string, signal?: AbortSignal): Promise<Airport[]> {
  const res = await fetch(`/api/airports?q=${encodeURIComponent(q)}&limit=8`, { signal });
  if (!res.ok) return [];
  const body = (await res.json()) as { results?: Airport[] };
  return body.results ?? [];
}

export function AirportPicker({
  value,
  onChange,
  error,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  error?: string;
}) {
  const t = useTranslations("settings.airports");
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Airport[]>([]);
  const [active, setActive] = useState(-1);
  const [known, setKnown] = useState<Record<string, Airport>>({});
  const full = value.length >= MAX_HOME_AIRPORTS;
  const open = results.length > 0 && !full;

  // Debounced search while typing.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(q, controller.signal)
        .then((list) => {
          setResults(list.filter((a) => !value.includes(a.iata)));
          setActive(-1);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, value]);

  // Look up display names for codes loaded from the profile.
  useEffect(() => {
    const missing = value.filter((c) => !known[c]);
    for (const code of missing) {
      search(code)
        .then((list) => {
          const hit = list.find((a) => a.iata === code);
          if (hit) setKnown((k) => ({ ...k, [code]: hit }));
        })
        .catch(() => undefined);
    }
  }, [value, known]);

  function pick(a: Airport) {
    setKnown((k) => ({ ...k, [a.iata]: a }));
    onChange([...value, a.iata]);
    setQuery("");
    setResults([]);
  }

  function move(i: number, dir: -1 | 1) {
    const next = [...value];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? results.length - 1 : a - 1));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      pick(results[active >= 0 ? active : 0]);
    } else if (e.key === "Escape") {
      setResults([]);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-input`} className="text-sm font-medium">
        {t("label")}
      </label>
      <p id={`${id}-hint`} className={`text-sm ${mutedCls}`}>
        {full ? t("full", { max: MAX_HOME_AIRPORTS }) : t("hint", { max: MAX_HOME_AIRPORTS })}
      </p>
      <div className="relative">
        <input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          aria-describedby={`${id}-hint`}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          disabled={full}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) setResults([]);
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
            {results.map((a, i) => (
              <li
                key={a.iata}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(a)}
                className={`flex min-h-11 cursor-pointer flex-col justify-center px-3 py-1 text-sm ${
                  i === active ? "bg-info-bg" : ""
                }`}
              >
                <span>
                  <strong>{a.iata}</strong> · {a.name}
                </span>
                <span className={mutedCls}>
                  {a.city}, {a.country}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {value.length === 0 ? (
        <p className={`text-sm ${mutedCls}`}>{t("none")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {value.map((code, i) => {
            const a = known[code];
            return (
              <li
                key={code}
                className="flex items-center justify-between gap-2 rounded-md border border-line p-2 pl-3"
              >
                <span className="min-w-0 text-sm">
                  <strong>{code}</strong>
                  {a && <span className={`block truncate ${mutedCls}`}>{a.name}</span>}
                  {i === 0 && <span className={`block ${mutedCls}`}>{t("preferred")}</span>}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button type="button" className={btnIcon} disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("moveUp", { code })}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" className={btnIcon} disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label={t("moveDown", { code })}>
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button type="button" className={btnSecondary} onClick={() => onChange(value.filter((c) => c !== code))} aria-label={t("remove", { code })}>
                    <span aria-hidden="true">×</span>
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
