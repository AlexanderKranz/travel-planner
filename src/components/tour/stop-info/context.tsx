"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { StopInfoView } from "@/lib/domain/stop-info";
import { getSharedTourStopInfo, getTourStopInfo } from "@/lib/server/stop-info/actions";
import { isIOS, requestPlaybackAudio } from "@/lib/stop-info/device";
import { playParts } from "@/lib/stop-info/queue";
import { hasVoice, type SpeechPart } from "@/lib/stop-info/speak";

/**
 * Stop info state of a page (docs/specs/city-tour-stop-info.md sections 5 and 6): where the info comes from (a signed-in
 * reader, or a share link by token), one loaded view per tour (the first expand of any stop loads the whole tour once),
 * which cards are open, and ONE speech controller, so only one utterance plays at a time on the page.
 */
export type StopInfoSource = { kind: "session" } | { kind: "share"; token: string };
type Load = { status: "idle" | "loading" | "error" } | { status: "loaded"; view: StopInfoView };
type Reading = { id: string; tourId: string; paused: boolean } | null;

type Ctx = {
  loads: Record<string, Load>;
  load: (tourId: string) => void;
  open: Record<string, Set<string>>;
  setOpen: (tourId: string, key: string, on: boolean) => void;
  speech: Speech;
};

export type Speech = {
  supported: boolean;
  voiceFor: (lang: string) => boolean;
  reading: Reading;
  speak: (id: string, tourId: string, parts: SpeechPart[], onDone?: () => void) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** iOS only: "no sound? turn off the silent switch" line while reading, until the viewer dismisses it. */
  silentHint: boolean;
  dismissSilentHint: () => void;
};

const StopInfoCtx = createContext<Ctx | null>(null);
const SourceCtx = createContext<StopInfoSource | null>(null);

const voicesSubscribe = (cb: () => void) => {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  synth?.addEventListener?.("voiceschanged", cb);
  return () => synth?.removeEventListener?.("voiceschanged", cb);
};
/** Voice languages as one stable string (useSyncExternalStore needs a comparable snapshot). */
const voicesSnapshot = () =>
  typeof window !== "undefined" && window.speechSynthesis
    ? window.speechSynthesis.getVoices().map((v) => v.lang.toLowerCase()).join("|")
    : "";
const noSubscribe = () => () => {};

/** Per-viewer convenience (browser storage): the silent-switch hint was dismissed. */
const SILENT_HINT_KEY = "readOut.silentHintDismissed";
function silentHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(SILENT_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function useSpeech(): Speech {
  const supported = useSyncExternalStore(noSubscribe, () => typeof window !== "undefined" && "speechSynthesis" in window, () => false);
  const voiceList = useSyncExternalStore(voicesSubscribe, voicesSnapshot, () => "");
  const voices = useMemo(() => (voiceList ? voiceList.split("|") : []), [voiceList]);
  const [reading, setReading] = useState<Reading>(null);
  const [silentHint, setSilentHint] = useState(false);
  const run = useRef(0);
  /** The utterance playing now: a live reference, or Chrome may collect it and never send its `end`. */
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return;
    const runs = run; // the run counter (not a DOM node): its latest value is what the cleanup must bump
    // No audio from a background tab.
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        run.current++;
        synth.cancel();
        setReading(null);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      // End the run first: the cancel's "canceled" error would otherwise move on to the next part.
      runs.current++;
      synth.cancel();
    };
  }, []);

  const voiceFor = useCallback((lang: string) => hasVoice(voices, lang), [voices]);

  const speak = useCallback((id: string, tourId: string, parts: SpeechPart[], onDone?: () => void) => {
    const synth = window.speechSynthesis;
    if (!synth || parts.length === 0) return;
    const my = ++run.current;
    // iOS mutes Web Speech on the silent switch; media playback may not be (Audio Session API, Safari 17+).
    requestPlaybackAudio(navigator as Parameters<typeof requestPlaybackAudio>[0]);
    if (isIOS(navigator) && !silentHintDismissed()) setSilentHint(true);
    setReading({ id, tourId, paused: false });
    // One part at a time; the first is spoken here, inside the tap (iOS needs that).
    playParts({
      synth,
      parts,
      make: (p) => {
        const u = new SpeechSynthesisUtterance(p.text);
        u.lang = p.lang;
        return u;
      },
      current: () => run.current === my,
      onUtterance: (u) => {
        utterance.current = u;
      },
      done: () => {
        setReading(null);
        onDone?.();
      },
      failed: () => {
        run.current++;
        synth.cancel();
        setReading(null);
      },
    });
  }, []);

  const pause = useCallback(() => {
    window.speechSynthesis?.pause();
    setReading((r) => (r ? { ...r, paused: true } : r));
  }, []);
  const resume = useCallback(() => {
    window.speechSynthesis?.resume();
    setReading((r) => (r ? { ...r, paused: false } : r));
  }, []);
  const stop = useCallback(() => {
    run.current++;
    window.speechSynthesis?.cancel();
    setReading(null);
  }, []);

  const dismissSilentHint = useCallback(() => {
    setSilentHint(false);
    try {
      window.localStorage.setItem(SILENT_HINT_KEY, "1");
    } catch {
      // Storage blocked: the hint comes back on the next read-out.
    }
  }, []);

  return useMemo(
    () => ({ supported, voiceFor, reading, speak, pause, resume, stop, silentHint, dismissSilentHint }),
    [supported, voiceFor, reading, speak, pause, resume, stop, silentHint, dismissSilentHint],
  );
}

const POLL_MS = 15_000;
const POLL_MAX = 8; // 2 minutes: the background budget is about 110 s

export function StopInfoProvider({ source, children }: { source: StopInfoSource; children: ReactNode }) {
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [open, setOpenState] = useState<Record<string, Set<string>>>({});
  const busy = useRef(new Set<string>());
  /** Re-checks per tour while the background fetch runs ("Infos werden geladen"). */
  const polls = useRef(new Map<string, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  const speech = useSpeech();

  // Leaving the page stops the re-checks; a response arriving afterwards schedules no new one.
  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const load = useCallback(
    /** `background`: a re-check while cards are shown; keeps the loaded view (no "loading" flash, focus stays). */
    function load(tourId: string, background = false) {
      if (busy.current.has(tourId)) return;
      busy.current.add(tourId);
      if (!background) setLoads((l) => ({ ...l, [tourId]: { status: "loading" } }));
      const call = source.kind === "share" ? getSharedTourStopInfo(source.token, tourId) : getTourStopInfo(tourId);
      void call
        .catch(() => ({ ok: false as const, error: "failed" as const }))
        .then((r) => {
          busy.current.delete(tourId);
          if (!alive.current) return;
          // A failed re-check keeps what is shown; a failed first load shows the error.
          if (r.ok || !background) setLoads((l) => ({ ...l, [tourId]: r.ok ? { status: "loaded", view: r.data } : { status: "error" } }));
          // While the background fetch runs, look again a few times so the cards appear without a reload.
          const n = polls.current.get(tourId) ?? 0;
          if (r.ok && r.data.loading && n < POLL_MAX) {
            polls.current.set(tourId, n + 1);
            const id = setTimeout(() => {
              timers.current.delete(id);
              load(tourId, true);
            }, POLL_MS);
            timers.current.add(id);
          } else if (r.ok && !r.data.loading) polls.current.delete(tourId);
        });
    },
    [source],
  );

  const setOpen = useCallback((tourId: string, key: string, on: boolean) => {
    setOpenState((o) => {
      const next = new Set(o[tourId] ?? []);
      if (on) next.add(key);
      else next.delete(key);
      return { ...o, [tourId]: next };
    });
  }, []);

  const value = useMemo(() => ({ loads, load, open, setOpen, speech }), [loads, load, open, setOpen, speech]);
  return (
    <SourceCtx.Provider value={source}>
      <StopInfoCtx.Provider value={value}>{children}</StopInfoCtx.Provider>
    </SourceCtx.Provider>
  );
}

/** Null outside a provider: the page shows no stop info (e.g. the PDF render or an unsaved draft). */
export function useStopInfoCtx(): Ctx | null {
  return useContext(StopInfoCtx);
}
