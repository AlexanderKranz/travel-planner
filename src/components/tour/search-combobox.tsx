"use client";

import { useEffect, useId, useState } from "react";
import { inputCls, mutedCls } from "@/components/ui/styles";

export type SearchStatus = "ok" | "unavailable" | "rate_limited" | "daily_limit";
export type SearchAnswer<T> = { items: T[]; status: SearchStatus };

type Props<T> = {
  label: string;
  placeholder?: string;
  hint?: string;
  minChars: number;
  debounceMs: number;
  /** Runs after the debounce for a query of at least `minChars`; aborted when the query changes. */
  search: (q: string, signal: AbortSignal) => Promise<SearchAnswer<T>>;
  itemKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Items that cannot be picked (already in the tour) stay visible but disabled. */
  isDisabled?: (item: T) => boolean;
  onPick: (item: T) => void;
  /** Status texts (translated by the caller). */
  texts: { searching: string; noResults: string; count: (n: number) => string; status: Record<Exclude<SearchStatus, "ok">, string>; results: string };
  disabled?: boolean;
};

/**
 * Accessible search field with a result list (combobox pattern, like the trip form's destination search): debounced,
 * keyboard navigable (arrows, Enter, Escape), results as `min-h-11` rows, a polite status line.
 */
export function SearchCombobox<T>({
  label,
  placeholder,
  hint,
  minChars,
  debounceMs,
  search,
  itemKey,
  renderItem,
  isDisabled,
  onPick,
  texts,
  disabled,
}: Props<T>) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<T[]>([]);
  const [status, setStatus] = useState<SearchStatus>("ok");
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const q = query.trim();
  const searching = q.length >= minChars;
  const open = searching && searched && items.length > 0;

  useEffect(() => {
    if (!searching || disabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      search(q, controller.signal)
        .then((r) => {
          if (controller.signal.aborted) return; // superseded by a newer query
          setItems(r.items);
          setStatus(r.status);
          setSearched(true);
          setActive(-1);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setItems([]);
          setStatus("unavailable");
          setSearched(true);
          setLoading(false);
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, searching, disabled, debounceMs, search]);

  function pick(item: T) {
    if (isDisabled?.(item)) return;
    onPick(item);
    setQuery("");
    setItems([]);
    setSearched(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setQuery("");
      setItems([]);
      setSearched(false);
      return;
    }
    if (!open) {
      // Enter in a search field never submits the surrounding form (that would plan the tour).
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(items[active >= 0 ? active : 0]);
    }
  }

  const statusText = loading
    ? texts.searching
    : searched && searching
      ? status !== "ok"
        ? texts.status[status]
        : items.length === 0
          ? texts.noResults
          : texts.count(items.length)
      : "";

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-input`} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          id={`${id}-input`}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          autoComplete="off"
          enterKeyHint="search"
          maxLength={100}
          placeholder={placeholder}
          value={query}
          disabled={disabled}
          onChange={(e) => {
            // Results of the previous query must not stay pickable while the new one runs.
            setQuery(e.target.value);
            setItems([]);
            setSearched(false);
          }}
          onKeyDown={onKeyDown}
          className={inputCls}
        />
        {open && (
          <ul
            id={`${id}-list`}
            role="listbox"
            aria-label={texts.results}
            className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-md border border-line-strong bg-card shadow-lg"
          >
            {items.map((item, i) => {
              const off = isDisabled?.(item) ?? false;
              return (
                <li
                  key={itemKey(item)}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={off || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(item)}
                  className={`flex min-h-11 items-center px-3 py-1.5 text-sm ${off ? "cursor-default opacity-60" : "cursor-pointer"} ${
                    i === active ? "bg-info-bg" : ""
                  }`}
                >
                  {renderItem(item)}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {hint && (
        <p id={`${id}-hint`} className={`text-sm ${mutedCls}`}>
          {hint}
        </p>
      )}
      <p role="status" className="sr-only">
        {statusText}
      </p>
      {statusText && !open && (
        <p aria-hidden="true" className={`text-sm ${mutedCls}`}>
          {statusText}
        </p>
      )}
    </div>
  );
}
