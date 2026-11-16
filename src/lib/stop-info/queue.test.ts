import { describe, expect, it, vi } from "vitest";
import { AFTER_CANCEL_MS, playParts, type QueueUtterance } from "./queue";

type U = { text: string; onend: (() => void) | null; onerror: ((e: { error?: string }) => void) | null } & QueueUtterance;

function fakeSynth(speaking = false) {
  const spoken: U[] = [];
  const synth = { speaking, pending: false, cancel: vi.fn(), speak: (u: U) => void spoken.push(u) };
  return { synth, spoken };
}

const parts = [
  { text: "1. Dom.", lang: "de" },
  { text: "Der Dom ist eine Kirche.", lang: "de" },
  { text: "Erbaut 1147", lang: "de" },
];

function start(synth: ReturnType<typeof fakeSynth>["synth"], current = () => true) {
  const done = vi.fn();
  const failed = vi.fn();
  const waits: { fn: () => void; ms: number }[] = [];
  playParts<U>({
    synth,
    parts,
    make: (p) => ({ text: p.text, onend: null, onerror: null }),
    current,
    done,
    failed,
    later: (fn, ms) => void waits.push({ fn, ms }),
  });
  return { done, failed, waits };
}

describe("playParts", () => {
  it("speaks the first part at once and each next part only after the previous one ends", () => {
    const { synth, spoken } = fakeSynth();
    const { done } = start(synth);
    expect(spoken.map((u) => u.text)).toEqual(["1. Dom."]);
    spoken[0].onend?.();
    expect(spoken.map((u) => u.text)).toEqual(["1. Dom.", "Der Dom ist eine Kirche."]);
    spoken[1].onend?.();
    spoken[2].onend?.();
    expect(spoken).toHaveLength(3);
    expect(done).toHaveBeenCalledOnce();
  });

  it("cancels only when something is playing, and then starts after a short pause", () => {
    const idle = fakeSynth(false);
    start(idle.synth);
    expect(idle.synth.cancel).not.toHaveBeenCalled();
    expect(idle.spoken).toHaveLength(1);
    const busy = fakeSynth(true);
    const { waits } = start(busy.synth);
    expect(busy.synth.cancel).toHaveBeenCalledOnce();
    expect(busy.spoken).toHaveLength(0);
    expect(waits.map((w) => w.ms)).toEqual([AFTER_CANCEL_MS]);
    waits[0].fn();
    expect(busy.spoken.map((u) => u.text)).toEqual(["1. Dom."]);
  });

  it("does not start after the pause when a newer read-out took over", () => {
    const busy = fakeSynth(true);
    let mine = true;
    const { waits } = start(busy.synth, () => mine);
    mine = false;
    waits[0].fn();
    expect(busy.spoken).toHaveLength(0);
  });

  it("ignores an error that follows the part's end", () => {
    const { synth, spoken } = fakeSynth();
    const { failed } = start(synth);
    spoken[0].onend?.();
    spoken[0].onerror?.({ error: "synthesis-failed" });
    expect(failed).not.toHaveBeenCalled();
    expect(spoken).toHaveLength(2);
  });

  it("an interrupted part goes on with the next; a real error ends the read-out", () => {
    const { synth, spoken } = fakeSynth();
    const { done, failed } = start(synth);
    spoken[0].onerror?.({ error: "interrupted" });
    spoken[0].onend?.(); // some engines send both: no double step
    expect(spoken.map((u) => u.text)).toEqual(["1. Dom.", "Der Dom ist eine Kirche."]);
    spoken[1].onerror?.({ error: "synthesis-failed" });
    expect(failed).toHaveBeenCalledOnce();
    expect(spoken).toHaveLength(2);
    expect(done).not.toHaveBeenCalled();
  });

  it("stops queuing once a newer read-out took over", () => {
    const { synth, spoken } = fakeSynth();
    let mine = true;
    const { done, failed } = start(synth, () => mine);
    mine = false;
    spoken[0].onend?.();
    spoken[0].onerror?.({ error: "synthesis-failed" });
    expect(spoken).toHaveLength(1);
    expect(done).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});
