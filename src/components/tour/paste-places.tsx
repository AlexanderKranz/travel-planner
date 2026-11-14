"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { btnSecondary, inputCls, labelCls, mutedCls } from "@/components/ui/styles";
import type { TourSuggestion } from "@/lib/domain/tour";
import { splitPlaceList } from "@/lib/tour/paste";
import { searchPlaces } from "@/lib/tour/search-client";

type Row = { query: string; options: TourSuggestion[]; pick: number; on: boolean };

/**
 * "Liste einfügen": code splits the pasted text, each name goes through the place search (one request after the
 * other, so the search rate limit holds), and the user confirms every match before anything is added. Never guessed:
 * a name without a result is listed as not found.
 */
export function PastePlaces({
  centre,
  room,
  isTaken,
  onAdd,
}: {
  centre: { lat: number; lon: number } | null;
  /** Places that still fit into the tour. */
  room: number;
  isTaken: (key: string) => boolean;
  onAdd: (picked: TourSuggestion[]) => void;
}) {
  const t = useTranslations("tours");
  const locale = useLocale();
  const id = useId();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  if (!centre || room <= 0) return null;

  async function run() {
    const names = splitPlaceList(text, room);
    if (names.length === 0) {
      setStatus(t("paste.none"));
      return;
    }
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setStatus(null);
    const out: Row[] = [];
    for (const [i, query] of names.entries()) {
      try {
        const res = await searchPlaces(query, centre!, locale, ac.signal);
        if (res.status !== "ok") {
          const why = res.status === "rate_limited" ? t("searchRateLimited") : res.status === "daily_limit" ? t("searchDailyLimit") : t("searchUnavailable");
          setStatus(`${why} ${t("paste.notSearched", { count: names.length - i, names: names.slice(i).join(", ") })}`);
          break;
        }
        const options = res.items.filter((s) => !isTaken(s.key)).slice(0, 3);
        out.push({ query, options, pick: 0, on: options.length > 0 });
        setRows([...out]);
      } catch {
        // Aborted (a new search started): stay quiet. Otherwise say which names were not searched, never drop them.
        if (!ac.signal.aborted) setStatus(t("paste.notSearched", { count: names.length - i, names: names.slice(i).join(", ") }));
        break;
      }
    }
    setRows([...out]);
    setBusy(false);
  }

  function add() {
    if (!rows) return;
    const picked = rows.filter((r) => r.on && r.options[r.pick]).map((r) => r.options[r.pick]);
    const unique = picked.filter((s, i) => picked.findIndex((x) => x.key === s.key) === i).slice(0, room);
    onAdd(unique);
    setRows(null);
    setText("");
  }

  const chosen = rows?.filter((r) => r.on && r.options[r.pick]).length ?? 0;
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="min-h-11 cursor-pointer content-center font-medium">{t("paste.open")}</summary>
      <div className="mt-2 flex flex-col gap-3">
        <label htmlFor={`${id}-text`} className={labelCls}>
          {t("paste.label")}
        </label>
        <textarea
          id={`${id}-text`}
          className={`${inputCls} min-h-28`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("paste.placeholder")}
          disabled={busy}
        />
        <p className={`text-sm ${mutedCls}`}>{t("paste.hint", { max: room })}</p>
        <button type="button" className={`${btnSecondary} self-start`} onClick={() => void run()} disabled={busy || !text.trim()}>
          {busy ? t("searching") : t("paste.search")}
        </button>
        {status && (
          <p role="status" className="text-sm">
            {status}
          </p>
        )}
        {rows && rows.length > 0 && (
          <>
            <ul className="flex flex-col gap-2" data-testid="paste-results">
              {rows.map((r, i) => (
                <li key={`${r.query}-${i}`} className="flex flex-col gap-1 rounded-lg border border-line p-2">
                  <span className={`text-sm ${mutedCls} break-words`}>{t("paste.query", { query: r.query })}</span>
                  {r.options.length === 0 ? (
                    <span className="text-sm">{t("paste.notFound")}</span>
                  ) : (
                    <label className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-5 shrink-0"
                        checked={r.on}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))}
                      />
                      {r.options.length === 1 ? (
                        <span className="break-words font-medium">{r.options[0].name}</span>
                      ) : (
                        <select
                          aria-label={t("paste.choose", { query: r.query })}
                          className={`${inputCls} min-w-0`}
                          value={r.pick}
                          onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pick: Number(e.target.value) } : x)))}
                        >
                          {r.options.map((o, k) => (
                            <option key={o.key} value={k}>
                              {o.address ? `${o.name} · ${o.address}` : o.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                  )}
                </li>
              ))}
            </ul>
            <button type="button" className={`${btnSecondary} self-start`} onClick={add} disabled={chosen === 0 || busy}>
              {t("paste.add", { count: chosen })}
            </button>
          </>
        )}
      </div>
    </details>
  );
}
