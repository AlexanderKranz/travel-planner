"use client";

import { useId, useState } from "react";
import { btnSecondary } from "@/components/ui/styles";

/**
 * Downloads the PDF via fetch so a server error shows as text instead of saving the JSON error body. With
 * `stopInfoLabel` a checkbox "Ortsinfos aufnehmen" (off by default) adds `stopInfo=1` (city-tour-stop-info 6, [Q2]).
 */
export function PdfButton({
  href,
  label,
  busyLabel,
  errorText,
  stopInfoLabel,
}: {
  href: string;
  label: string;
  busyLabel: string;
  errorText: string;
  stopInfoLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [withInfo, setWithInfo] = useState(false);
  const checkId = useId();
  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(withInfo ? `${href}${href.includes("?") ? "&" : "?"}stopInfo=1` : href);
      if (!res.ok || !res.headers.get("Content-Type")?.includes("application/pdf")) throw new Error(String(res.status));
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "plan.pdf";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex w-full flex-col gap-1 sm:w-auto">
      <button type="button" onClick={download} disabled={busy} className={`${btnSecondary} w-full sm:w-auto`}>
        {busy ? busyLabel : label}
      </button>
      {stopInfoLabel && (
        <label htmlFor={checkId} className="flex min-h-11 items-center gap-2 text-sm">
          <input id={checkId} type="checkbox" className="size-5 shrink-0" checked={withInfo} onChange={(e) => setWithInfo(e.target.checked)} />
          {stopInfoLabel}
        </label>
      )}
      {failed && (
        <p role="alert" className="text-sm text-danger">
          {errorText}
        </p>
      )}
    </div>
  );
}
