import type { SpeechPart } from "./speak";

/**
 * Plays read-out parts one after the other (docs/specs/city-tour-stop-info.md section 6). Queuing all utterances at
 * once right after `cancel()` lets desktop engines drop the first ones (only the fact lines were heard), so each part
 * is spoken from the previous one's `end`. The first part is spoken synchronously, inside the tap (iOS needs that).
 * Pure apart from the passed synth, so it is unit-testable with a fake.
 */
export type QueueUtterance = {
  // `never` parameters: the real utterance's handlers (typed with `this` and an event) fit; ours ignore or narrow it.
  onend: ((ev: never) => unknown) | null;
  onerror: ((ev: never) => unknown) | null;
};
export type QueueSynth<U extends QueueUtterance> = {
  speaking: boolean;
  pending: boolean;
  cancel: () => void;
  speak: (u: U) => void;
};

/**
 * Pause after cancelling a playing read-out before the next one starts: engines finish a cancel asynchronously and can
 * swallow an utterance spoken right after it. iOS stays activated, since something was already playing.
 */
export const AFTER_CANCEL_MS = 150;

/** Errors that only mean "this utterance was cut off" (by a cancel or another utterance): go on with the next part. */
const SKIPPABLE = new Set(["interrupted", "canceled"]);

export function playParts<U extends QueueUtterance>(p: {
  synth: QueueSynth<U>;
  parts: SpeechPart[];
  make: (part: SpeechPart) => U;
  /** False once a newer read-out (or stop) took over: no more parts, no callbacks. */
  current: () => boolean;
  /** Called with each utterance before it is spoken (keep a reference: Chrome may drop events of collected ones). */
  onUtterance?: (u: U) => void;
  done: () => void;
  failed: () => void;
  /** Runs a callback later (`setTimeout` in the app, synchronous in tests). */
  later?: (fn: () => void, ms: number) => void;
}): void {
  const { synth, parts } = p;
  // Cancel only when something plays; a cancel on an idle engine can still swallow the next speak.
  const busy = synth.speaking || synth.pending;
  if (busy) synth.cancel();
  const at = (i: number) => {
    if (!p.current()) return;
    if (i >= parts.length) return p.done();
    const u = p.make(parts[i]);
    let moved = false;
    const next = () => {
      if (moved) return;
      moved = true;
      at(i + 1);
    };
    u.onend = next;
    u.onerror = (e: { error?: string }) => {
      // An error after `end` (or a second error) belongs to a part that is already done.
      if (moved || !p.current()) return;
      if (e.error && SKIPPABLE.has(e.error)) return next();
      moved = true;
      p.failed();
    };
    p.onUtterance?.(u);
    synth.speak(u);
  };
  if (busy) (p.later ?? ((fn, ms) => void setTimeout(fn, ms)))(() => at(0), AFTER_CANCEL_MS);
  else at(0);
}
