"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { StopInfoView } from "@/lib/domain/stop-info";
import { getSharedTourStopInfo, getTourStopInfo } from "@/lib/server/stop-info/actions";
import type { SpeechPart } from "@/lib/stop-info/speak";

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

function useSpeech(): Speech {
  const supported = useSyncExternalStore(noSubscribe, () => typeof window !== "undefined" && "speechSynthesis" in window, () => false);
  const voiceList = useSyncExternalStore(voicesSubscribe, voicesSnapshot, () => "");
  const voices = useMemo(() => (voiceList ? voiceList.split("|") : []), [voiceList]);
  const [reading, setReading] = useState<Reading>(null);
  const run = useRef(0);

  useEffect(() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return;
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
      synth.cancel();
    };
  }, []);

  const voiceFor = useCallback((lang: string) => voices.some((v) => v === lang || v.startsWith(`${lang}-`)), [voices]);

  const speak = useCallback((id: string, tourId: string, parts: SpeechPart[], onDone?: () => void) => {
    const synth = window.speechSynthesis;
    if (!synth || parts.length === 0) return;
    const my = ++run.current;
    synth.cancel();
    setReading({ id, tourId, paused: false });
    // All utterances are queued inside the tap (iOS needs the first speak there).
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p.text);
      u.lang = p.lang;
      if (i === parts.length - 1) {
        u.onend = () => {
          if (run.current !== my) return;
          setReading(null);
          onDone?.();
        };
      }
      synth.speak(u);
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

  return { supported, voiceFor, reading, speak, pause, resume, stop };
}

export function StopInfoProvider({ source, children }: { source: StopInfoSource; children: ReactNode }) {
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [open, setOpenState] = useState<Record<string, Set<string>>>({});
  const busy = useRef(new Set<string>());
  const speech = useSpeech();

  const load = useCallback(
    (tourId: string) => {
      if (busy.current.has(tourId)) return;
      busy.current.add(tourId);
      setLoads((l) => ({ ...l, [tourId]: { status: "loading" } }));
      const call = source.kind === "share" ? getSharedTourStopInfo(source.token, tourId) : getTourStopInfo(tourId);
      void call
        .catch(() => ({ ok: false as const, error: "failed" as const }))
        .then((r) => {
          setLoads((l) => ({ ...l, [tourId]: r.ok ? { status: "loaded", view: r.data } : { status: "error" } }));
          // A failed or partial load may be retried by the next expand.
          if (!r.ok || r.data.pending.length > 0) busy.current.delete(tourId);
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
