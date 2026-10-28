"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { CheckboxField, SelectField, TextField } from "@/components/ui/fields";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnPrimary, btnSecondary, inputCls, mutedCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { SHARE_EXPIRY_DAYS } from "@/lib/domain/share";
import { createShareLink } from "@/lib/server/shares";

/** Create form. The URL comes back once: show it with copy (aria-live) and native share. */
export function ShareCreate({ tripId, disabledReason }: { tripId: string; disabledReason: string | null }) {
  const t = useTranslations("share");
  const router = useRouter();
  const urlId = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState("");
  const [includeItems, setIncludeItems] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCopied(false);
    start(async () => {
      const r = await createShareLink(tripId, {
        label: label.trim() === "" ? null : label.trim(),
        expiresInDays: expiry === "" ? null : Number(expiry),
        includeItems,
        includeItemNotes: includeItems && includeNotes,
      });
      if (r.ok) {
        setUrl(r.data.url);
        router.refresh();
      } else setError(r.error);
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url!);
      setCopied(true);
    } catch {
      urlRef.current?.select();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={create} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t("label")} hint={t("labelHint")} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          <SelectField label={t("expiry.label")} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="">{t("expiry.never")}</option>
            {SHARE_EXPIRY_DAYS.map((d) => (
              <option key={d} value={d}>
                {t(`expiry.${d}`)}
              </option>
            ))}
          </SelectField>
        </div>
        <div>
          <CheckboxField
            label={t("includeItems")}
            checked={includeItems}
            onChange={(e) => {
              setIncludeItems(e.target.checked);
              if (!e.target.checked) setIncludeNotes(false);
            }}
          />
          <p className={`pl-8 text-sm ${mutedCls}`}>{t("includeItemsHint")}</p>
          <CheckboxField
            label={t("includeNotes")}
            checked={includeItems && includeNotes}
            disabled={!includeItems}
            onChange={(e) => setIncludeNotes(e.target.checked)}
          />
          <p className={`pl-8 text-sm ${mutedCls}`}>{t("includeNotesHint")}</p>
        </div>
        {disabledReason && <p className={`text-sm ${mutedCls}`}>{disabledReason}</p>}
        <div>
          <button type="submit" className={`${btnPrimary} w-full sm:w-auto`} disabled={pending || !!disabledReason}>
            {t("create")}
          </button>
        </div>
      </form>
      <ErrorBanner error={error} />
      {url && (
        <div className="flex flex-col gap-2 rounded-md border border-green-700 bg-green-50 p-3 text-green-950 dark:border-green-400 dark:bg-green-950 dark:text-green-100">
          <label htmlFor={urlId} className="text-sm font-medium">
            {t("createdTitle")}: {t("linkLabel")}
          </label>
          <input id={urlId} ref={urlRef} readOnly value={url} onFocus={(e) => e.currentTarget.select()} className={`${inputCls} text-foreground`} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" className={btnSecondary} onClick={copy}>
              {t("copy")}
            </button>
            {canShare && (
              <button type="button" className={btnSecondary} onClick={() => navigator.share({ url }).catch(() => {})}>
                {t("nativeShare")}
              </button>
            )}
          </div>
          <p role="status" aria-live="polite" className="min-h-5 text-sm font-medium">
            {copied ? t("copied") : ""}
          </p>
          <p className="text-sm">{t("onceNote")}</p>
        </div>
      )}
    </div>
  );
}
