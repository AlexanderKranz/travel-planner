"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnPrimary, btnSecondary, mutedCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { asPlanError, formatElapsed, POLL_INTERVAL_MS, progressStage, shouldKeepPolling } from "./helpers";

type Phase = "idle" | "running" | "polling";

/**
 * Starts plan generation with one POST /plan; the server loads places and writes the plan, so leaving the page
 * cannot stop it. A running timer and an elapsed-based status text give feedback. If the request dies (network,
 * proxy timeout) or the server says "busy", it polls GET /plan until the lock is released. With `watchOnly` or
 * `initialBusy` (a return visit during a run) it only polls.
 */
export function PlanRunner({
  tripId,
  locale,
  label,
  initialBusy = false,
  watchOnly = false,
  disabled = false,
  secondary = false,
  fresh = false,
  confirm,
}: {
  tripId: string;
  locale: string;
  label?: string;
  initialBusy?: boolean;
  watchOnly?: boolean;
  disabled?: boolean;
  secondary?: boolean;
  /** Regenerate: a new AI version even when the input is unchanged (sent with force: cache-only places, no new wait). */
  fresh?: boolean;
  /** Ask before starting: inline confirmation with this text and button labels. */
  confirm?: { text: string; yes: string; no: string };
}) {
  const t = useTranslations("plan.runner");
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(initialBusy || watchOnly ? "polling" : "idle");
  const [error, setError] = useState<ActionError | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  /** A run ended without a new version (killed, or places pending after the connection dropped). */
  const [incomplete, setIncomplete] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [asking, setAsking] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const startedAt = useRef(Date.now());
  /** Latest version number when this run started (or when the first poll saw the lock); null = unknown, no alarm. */
  const baseline = useRef<number | null>(null);
  const url = `/api/trips/${encodeURIComponent(tripId)}/plan`;

  const done = useCallback(() => {
    startRefresh(() => router.refresh());
    setPhase("idle");
  }, [router]);

  /** One read of the plan state: busy flag and latest version number (0 = none). Null when it cannot be read. */
  const readState = useCallback(async (): Promise<{ busy: boolean; versionNo: number } | null> => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        state?: { busy?: boolean; version?: { meta?: { versionNo?: number } } | null };
      };
      return { busy: json.state?.busy === true, versionNo: json.state?.version?.meta?.versionNo ?? 0 };
    } catch {
      return null;
    }
  }, [url]);

  // Elapsed seconds drive the staged status text.
  useEffect(() => {
    if (phase === "idle") return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Poll while the server holds the generation lock.
  useEffect(() => {
    if (phase !== "polling") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!shouldKeepPolling(Date.now() - startedAt.current)) {
        setTimedOut(true);
        setPhase("idle");
        return;
      }
      const state = await readState();
      if (cancelled) return;
      if (state && !state.busy) {
        // The lock is gone. No new version = the run did not finish (a finished run, also a restore, adds one;
        // an unchanged result cannot happen from the buttons, they only show when the input changed or use `fresh`).
        const noNew = baseline.current !== null && state.versionNo <= baseline.current;
        if (noNew) {
          // No refresh: a watching runner unmounts when the page learns "not busy", which would hide the message.
          setIncomplete(true);
          setPhase("idle");
        } else done();
        return;
      }
      if (state && baseline.current === null) baseline.current = state.versionNo;
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, watchOnly ? 0 : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, done, watchOnly, readState]);

  async function run(force = false) {
    setError(null);
    setTimedOut(false);
    setIncomplete(false);
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("running");
    baseline.current = (await readState())?.versionNo ?? null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale, ...(force || fresh ? { force: true } : {}), ...(fresh ? { fresh: true } : {}) }),
      });
      if (res.ok) return done();
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      const code = asPlanError(json.error);
      if (code === "busy") {
        // The per-user guard also answers busy while ANOTHER trip is being planned: look at this trip once.
        const state = await readState();
        if (state && !state.busy) {
          setPhase("idle");
          return setError("busy");
        }
        return setPhase("polling");
      }
      setPhase("idle");
      setError(code);
    } catch {
      // The server keeps working after the browser lost the connection.
      setPhase("polling");
    }
  }

  const working = phase !== "idle" || refreshing;
  const stage = progressStage(elapsed);

  return (
    <div className="flex flex-col gap-3">
      {!watchOnly && !asking && (
        <div>
          <button
            type="button"
            className={secondary ? btnSecondary : btnPrimary}
            onClick={() => (confirm ? setAsking(true) : run())}
            disabled={disabled || working}
            aria-busy={working}
          >
            {working ? t("working") : (label ?? t("start"))}
          </button>
        </div>
      )}
      {!watchOnly && asking && confirm && (
        <div role="group" aria-label={label} className="flex flex-col gap-2">
          <p className="text-sm">{confirm.text}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={disabled}
              onClick={() => {
                setAsking(false);
                void run();
              }}
            >
              {confirm.yes}
            </button>
            <button type="button" className={btnSecondary} onClick={() => setAsking(false)}>
              {confirm.no}
            </button>
          </div>
        </div>
      )}
      <div role="status" aria-live="polite" className="text-sm">
        {working && (
          <p className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-transparent motion-reduce:animate-none"
            />
            <span>
              {watchOnly || initialBusy ? t("busyElsewhere") : t(stage)}{" "}
              <span className="tabular-nums">{formatElapsed(elapsed)}</span>
            </span>
          </p>
        )}
        {incomplete && !working && <p className={mutedCls}>{t("incomplete")}</p>}
        {timedOut && (
          <p className={mutedCls}>
            {t("timedOut")}{" "}
            <button type="button" className="min-h-11 underline underline-offset-2" onClick={done}>
              {t("reload")}
            </button>
          </p>
        )}
      </div>
      <PlanErrorBanner error={error} />
      {error === "places_pending" && !working && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} onClick={() => run()}>
            {t("retry")}
          </button>
          <button type="button" className={btnSecondary} onClick={() => run(true)}>
            {t("generateAnyway")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Plan-specific wording for the errors the plan routes can return. */
export function PlanErrorBanner({ error }: { error: ActionError | null }) {
  const t = useTranslations("plan.errors");
  if (!error) return null;
  if (error === "unauthenticated") return <ErrorBanner error={error} />;
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg"
    >
      {t(error)}
    </div>
  );
}
