"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TextField } from "@/components/ui/fields";
import { btnSecondary, cardCls, linkCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain/result";

export const PURPOSE_NAME_MAX = 80;

type Reply = { purposeId?: string; name?: string; created?: boolean; error?: ActionError };

/**
 * "Save as trip purpose" for a list that was searched with a typed text (spec 13.4). One POST, no model call: the
 * server copies the text and the tags it already has. The parent shows this only for an unsaved one-off.
 */
export function SavePurpose({ searchId, defaultName }: { searchId: string; defaultName: string }) {
  const t = useTranslations("discover.savePurpose");
  const id = useId();
  const [name, setName] = useState(defaultName.slice(0, PURPOSE_NAME_MAX));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [saved, setSaved] = useState<{ purposeId: string; name: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/destination-search/${encodeURIComponent(searchId)}/save-purpose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as Reply;
      if (res.ok && json.purposeId) {
        setSaved({ purposeId: json.purposeId, name: json.name ?? name.trim() });
        return;
      }
      setError(json.error ?? "failed");
    } catch {
      setError("failed");
    }
    setPending(false);
  }

  if (saved) {
    return (
      <section aria-labelledby={`${id}-title`} className={`${cardCls} flex flex-col gap-2`}>
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {t("title")}
        </h2>
        <p role="status">
          {t("saved", { name: saved.name })}{" "}
          <Link href={`/app/purposes/${saved.purposeId}`} className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("open")}
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className={`${cardCls} flex flex-col gap-3`}>
      <h2 id={`${id}-title`} className="text-sm font-semibold">
        {t("title")}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end" aria-busy={pending}>
        <div className="sm:flex-1">
          <TextField label={t("name")} value={name} maxLength={PURPOSE_NAME_MAX} onChange={(e) => setName(e.target.value)} required />
        </div>
        <button type="submit" className={btnSecondary} disabled={pending || name.trim().length === 0}>
          {pending ? t("saving") : t("submit")}
        </button>
      </form>
      <ErrorBanner error={error} />
    </section>
  );
}
