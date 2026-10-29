"use client";

import { useState } from "react";
import { btnSecondary } from "@/components/ui/styles";

/** Downloads the PDF via fetch so a server error shows as text instead of saving the JSON error body. */
export function PdfButton({ href, label, busyLabel, errorText }: { href: string; label: string; busyLabel: string; errorText: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function download() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(href);
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
      {failed && (
        <p role="alert" className="text-sm text-danger">
          {errorText}
        </p>
      )}
    </div>
  );
}
