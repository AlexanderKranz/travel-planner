"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { monthName } from "@/components/trips/trip-title";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnPrimary, btnSecondary, cardCls, errorCls, mutedCls, pillCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain/result";
import type { DestinationSearchView } from "@/lib/domain/destination-search";
import { CHECKING_AFTER_S, dropTotals, hasTrip, POLL_GIVE_UP_MS, POLL_INTERVAL_MS } from "./helpers";
import { SuggestionCardView } from "./suggestion-card";

type Reply = { search?: DestinationSearchView; error?: ActionError };

async function call(url: string, method: "GET" | "POST"): Promise<{ status: number; body: Reply } | null> {
  try {
    const res = await fetch(url, { method, cache: "no-store" });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Reply };
  } catch {
    return null;
  }
}

/**
 * The saved list. While the server is still working (`running`) it polls GET /api/destination-search/[id]; the
 * server finishes and saves even when the browser left, so reopening a running search is safe. "Show other places"
 * is the one extra round (POST .../more). Cards are shown as they are: 1 or 2 are never padded.
 */
export function DiscoverResults({ initial, tripsByGeo }: { initial: DestinationSearchView; tripsByGeo: Record<string, string> }) {
  const t = useTranslations("discover");
  const td = useTranslations("discover.drops");
  const f = useFormatter();
  const locale = useLocale();
  const [search, setSearch] = useState(initial);
  const [error, setError] = useState<ActionError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  /** Bumped by "Check again" to restart the polling window. */
  const [epoch, setEpoch] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const running = search.status === "running";
  const working = running || moreBusy;

  // Elapsed seconds drive the status text.
  useEffect(() => {
    if (!working) return;
    startedAt.current = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [working]);

  const poll = useCallback(async (): Promise<boolean> => {
    const r = await call(`/api/destination-search/${encodeURIComponent(initial.id)}`, "GET");
    if (!r) return true; // network hiccup: keep trying
    if (r.status === 200 && r.body.search) {
      setSearch(r.body.search);
      return r.body.search.status === "running";
    }
    setError(r.body.error ?? "failed");
    return false;
  }, [initial.id]);

  // Poll while the server is working.
  useEffect(() => {
    if (!running || moreBusy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const since = Date.now();
    const tick = async () => {
      if (Date.now() - since > POLL_GIVE_UP_MS) {
        if (!cancelled) setTimedOut(true);
        return;
      }
      const again = await poll();
      if (!cancelled && again) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [running, moreBusy, poll, epoch]);

  async function showOthers() {
    setError(null);
    setConflict(false);
    setMoreBusy(true);
    setElapsed(0);
    const r = await call(`/api/destination-search/${encodeURIComponent(initial.id)}/more`, "POST");
    setMoreBusy(false);
    if (!r) {
      // The server keeps working after the connection dropped: look at the row.
      setSearch((s) => ({ ...s, status: "running" }));
      return;
    }
    if (r.status === 200 && r.body.search) return setSearch(r.body.search);
    if (r.body.error === "busy") return setSearch((s) => ({ ...s, status: "running" }));
    if (r.body.error === "conflict") {
      setConflict(true);
      await poll();
      return;
    }
    setError(r.body.error ?? "failed");
  }

  const cards = search.cards;
  const drops = dropTotals(search.drops);
  const monthsText = search.months.map((m) => monthName(m, locale, "long")).join(", ");
  const done = search.status === "done";
  const failed = search.status === "failed";
  const isDrive = search.travelMode === "drive";

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-wrap gap-2" aria-label={search.purposeName}>
        <li className={pillCls}>{search.purposeName}</li>
        {monthsText && <li className={pillCls}>{monthsText}</li>}
        {search.travelMode === "drive" && search.homeName && <li className={pillCls}>{t("list.pillStart", { place: search.homeName })}</li>}
        {search.travelMode === "drive" && search.maxDriveHours !== null && (
          <li className={pillCls}>{t("list.pillDriveLimit", { hours: f.number(search.maxDriveHours, { maximumFractionDigits: 1 }) })}</li>
        )}
        {search.origins.length > 0 && <li className={pillCls}>{t("list.pillOrigins", { airports: search.origins.join(", ") })}</li>}
        {search.origins.length > 0 && search.maxFlightHours !== null && (
          <li className={pillCls}>{t("list.pillLimit", { hours: f.number(search.maxFlightHours, { maximumFractionDigits: 1 }) })}</li>
        )}
      </ul>
      <p className={`text-sm ${mutedCls}`}>{t("list.created", { date: f.dateTime(new Date(search.createdAt), { dateStyle: "medium" }) })}</p>

      <div role="status" aria-live="polite">
        {working && (
          <div className={`${cardCls} flex flex-col gap-2`}>
            <p className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-block size-5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-transparent motion-reduce:animate-none"
              />
              <span>{moreBusy ? t("list.showingOthers") : elapsed < CHECKING_AFTER_S ? t("running.ideas") : t("running.checking")}</span>
            </p>
            <p className={`text-sm ${mutedCls}`}>{t("running.leave")}</p>
          </div>
        )}
        {timedOut && running && !moreBusy && (
          <p className={`text-sm ${mutedCls}`}>
            {t("running.timedOut")}{" "}
            <button type="button" className="min-h-11 underline underline-offset-2" onClick={() => {
                setTimedOut(false);
                setEpoch((n) => n + 1);
              }}>
              {t("running.reload")}
            </button>
          </p>
        )}
      </div>

      {failed && (
        <div className="flex flex-col gap-3">
          <p className="font-medium">{t("list.failed")}</p>
          <ErrorBanner error={search.error ?? "failed"} />
          <div>
            <Link href="/app/trips/discover" className={btnSecondary}>
              {t("list.tryAgain")}
            </Link>
          </div>
        </div>
      )}
      <ErrorBanner error={error} />
      {conflict && (
        <p role="status" className={errorCls}>
          {t("list.conflict")}
        </p>
      )}

      {cards.length > 0 && (
        <section aria-labelledby="discover-cards" className="flex flex-col gap-3">
          <h2 id="discover-cards" className="text-xl font-bold">
            {t("list.cards")}
          </h2>
          {done && cards.length < 3 && <p className="text-sm">{t("list.fewResults", { count: cards.length })}</p>}
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <li key={card.id} className="min-w-0">
                <SuggestionCardView card={card} searchId={search.id} tripId={hasTrip(card, tripsByGeo)} driveFrom={search.homeName} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {done && cards.length === 0 && (
        <div className={`${cardCls} flex flex-col gap-2`}>
          <p className="font-medium">{t("list.empty")}</p>
          <p className={`text-sm ${mutedCls}`}>{t(isDrive ? "list.widenDrive" : "list.widen")}</p>
        </div>
      )}

      {!running && drops.length > 0 && (
        <section aria-labelledby="discover-drops" className="flex flex-col gap-1">
          <h2 id="discover-drops" className="text-sm font-semibold">
            {td("title")}
          </h2>
          <ul className={`text-sm ${mutedCls}`}>
            {drops.map(([reason, count]) => (
              <li key={reason}>{td(isDrive && reason === "too_far" ? "too_far_drive" : reason, { count })}</li>
            ))}
          </ul>
        </section>
      )}

      {done && !working && (
        <div className="flex flex-col items-start gap-2">
          {search.canShowOthers ? (
            <button type="button" className={btnPrimary} onClick={showOthers}>
              {t("list.showOthers")}
            </button>
          ) : search.rounds >= 2 ? (
            <p className={`text-sm ${mutedCls}`}>{t("list.roundsUsed")}</p>
          ) : !search.aiEnabled ? (
            <p className={`text-sm ${mutedCls}`}>{t("list.aiOff")}</p>
          ) : null}
          <Link href="/app/trips/discover" className={btnSecondary}>
            {t("newSearch")}
          </Link>
        </div>
      )}

      <section aria-labelledby="discover-footer" className="flex flex-col gap-1 rounded-[14px] border border-dashed border-line-strong p-4">
        <h2 id="discover-footer" className="text-sm font-semibold">
          {t("list.footer")}
        </h2>
        <ul className={`list-disc pl-5 text-sm ${mutedCls}`}>
          <li>{t(isDrive ? "list.footerDrive" : "list.footerFlights")}</li>
          <li>{t("list.footerWishes")}</li>
          <li>{t("list.footerReasons")}</li>
        </ul>
      </section>
    </div>
  );
}
