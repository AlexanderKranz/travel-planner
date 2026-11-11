"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, useSyncExternalStore } from "react";
import { btnSecondary, errorCls, mutedCls } from "@/components/ui/styles";
import { MAX_ITINERARY_IMAGES, type ExtractedStop, type ItineraryContext } from "@/lib/domain/itinerary";
import { extractItinerary } from "@/lib/server/itinerary";
import { downscaleImage, readPdf } from "./itinerary-browser";
import {
  checkFile,
  extractFromSource,
  FILE_ACCEPT,
  type ItineraryErrorKey,
  type ItineraryOutcome,
} from "./itinerary-read";

export type UploadResult = { stops: ExtractedStop[]; truncatedTo?: number };

/**
 * File picker and camera button. Reads the file in the browser, runs prefilter, parser and (on a miss) the server
 * extraction, and reports a proposal. The file is never stored; the form stays usable while it reads.
 */
export function StopsUpload({
  tripId,
  ctx,
  notes,
  hasNotes,
  showFromNotes,
  onResult,
}: {
  tripId: string | null;
  /** The trip as it is in the form right now. */
  ctx: ItineraryContext;
  notes: string;
  hasNotes: boolean;
  /** Offer "Take from notes" (no derived result yet). */
  showFromNotes: boolean;
  onResult: (r: UploadResult) => void;
}) {
  const t = useTranslations("trips.stops");
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ItineraryErrorKey | null>(null);
  const touch = useSyncExternalStore(
    () => () => undefined,
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );

  const extract = (input: Parameters<typeof extractItinerary>[1]) => extractItinerary(tripId, input, ctx);

  async function run(job: () => Promise<{ outcome: ItineraryOutcome; truncatedTo?: number }>) {
    setError(null);
    setBusy(true);
    try {
      const { outcome, truncatedTo } = await job();
      if (outcome.ok) onResult({ stops: outcome.stops, truncatedTo });
      else setError(outcome.error);
    } catch {
      setError("unreadable");
    } finally {
      setBusy(false);
    }
  }

  function onFiles(files: FileList | null) {
    const list = [...(files ?? [])];
    if (fileRef.current) fileRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
    if (list.length === 0) return;
    const checks = list.map((f) => checkFile(f));
    const bad = checks.find((c) => !c.ok);
    if (bad && !bad.ok) return setError(bad.error);
    const pdf = list.find((_, i) => (checks[i] as { kind: string }).kind === "pdf");
    void run(async () => {
      if (pdf) {
        const read = await readPdf(pdf);
        const outcome = await extractFromSource(read.source, ctx, extract);
        return { outcome, truncatedTo: read.truncatedTo };
      }
      const images = await Promise.all(list.slice(0, MAX_ITINERARY_IMAGES).map(downscaleImage));
      return { outcome: await extractFromSource({ kind: "images", images }, ctx, extract) };
    });
  }

  function fromNotes() {
    void run(async () => ({ outcome: await extractFromSource({ kind: "text", text: notes }, ctx, extract) }));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button type="button" className={btnSecondary} disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("upload")}
        </button>
        {touch && (
          <button type="button" className={btnSecondary} disabled={busy} onClick={() => cameraRef.current?.click()}>
            {t("camera")}
          </button>
        )}
        {showFromNotes && hasNotes && (
          <button type="button" className={btnSecondary} disabled={busy} onClick={fromNotes}>
            {t("fromNotes")}
          </button>
        )}
      </div>
      {/* Hidden inputs, opened by the buttons above (the buttons are the keyboard and screen reader targets). */}
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        accept={FILE_ACCEPT}
        multiple
        onChange={(e) => onFiles(e.target.files)}
      />
      <input
        ref={cameraRef}
        type="file"
        className="hidden"
        accept="image/*"
        capture="environment"
        onChange={(e) => onFiles(e.target.files)}
      />
      <p className={`text-sm ${mutedCls}`}>{t("uploadHint")}</p>
      <div role="status" aria-live="polite" className="text-sm">
        {busy && (
          <p className="flex items-center gap-2">
            <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
            {t("reading")}
          </p>
        )}
        {error && <p className={errorCls}>{t(`error.${error}`)}</p>}
      </div>
    </div>
  );
}
