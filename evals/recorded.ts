/** Recorded model responses (spec 7): `evals/recorded/<fixture>.<task>.json`. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiUsageRecord } from "@/lib/domain/ai";
import type { FixtureId } from "./build-input";

export type RecordedTask =
  | "tags" | "generate" | "patch" | "drive" | "needbase" | "familypatch" | "uncoveredpatch" | "nogolfbase" | "golfpatch" | "golfeveryday"
  // port places (cruise): generate with stops from the confirmed stops / from the notes, with Dürnstein failed, the patch on the plan-7 base,
  // and "walks -> concrete sights" with no day selected on the stops generation with generic port sights (2026-11-12)
  | "stops" | "stopsnotes" | "stopsfail" | "portpatch" | "portsights";
export type Recording<T> = {
  promptVersion: string;
  model: string;
  inputHash: string;
  output: T;
  usage: Omit<AiUsageRecord, "latencyMs"> & { latencyMs?: number };
  recordedAt: string;
};

export const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.url)), "recorded");
export const recordingPath = (id: FixtureId, task: RecordedTask) => join(RECORDED_DIR, `${id}.${task}.json`);

export function readRecording<T>(id: FixtureId, task: RecordedTask): Recording<T> | null {
  const p = recordingPath(id, task);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Recording<T>) : null;
}

export function writeRecording<T>(id: FixtureId, task: RecordedTask, rec: Recording<T>): void {
  writeFileSync(recordingPath(id, task), JSON.stringify(rec, null, 2) + "\n");
}
