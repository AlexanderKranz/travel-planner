"use client";

import { ClientForm } from "@/components/ui/client-form";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { TextField } from "@/components/ui/fields";
import { btnPrimary, linkCls, mutedCls, pillAccentCls, pillCls } from "@/components/ui/styles";
import type { FeedbackLookup } from "@/lib/domain/feedback";
import { lookupFeedbackRef } from "@/lib/server/admin/feedback";

const KNOWN = ["forbidden", "rate_limited", "not_found", "failed"] as const;

/** Reference lookup: email, date, type, status, issue link and the 5-minute screenshot link. Each lookup is audited server-side. */
export function FeedbackLookupForm() {
  const t = useTranslations("admin.feedback.lookup");
  const f = useFormatter();
  const [ref, setRef] = useState("");
  const [result, setResult] = useState<FeedbackLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    start(async () => {
      try {
        const r = await lookupFeedbackRef(ref);
        if (r.ok) setResult(r.data);
        else setError(t(`errors.${(KNOWN as readonly string[]).includes(r.error) ? r.error : "failed"}`));
      } catch {
        // A dropped connection must not hand the error to the boundary and replace the admin page.
        setError(t("errors.failed"));
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-sans text-sm font-semibold text-heading">{t("title")}</h3>
      <ClientForm onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("label")}
            hint={t("hint")}
            name="feedback-ref"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="FB-k3x9p2qa"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
          />
        </div>
        <button type="submit" className={btnPrimary} disabled={pending || !ref.trim()}>
          {t("submit")}
        </button>
      </ClientForm>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
            {error}
          </p>
        )}
        {result && (
          <div role="status" className="flex flex-col gap-2 rounded-lg border border-line bg-sunken p-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className={mutedCls}>{t("ref")}</dt>
              <dd><code>{result.ref}</code></dd>
              <dt className={mutedCls}>{t("email")}</dt>
              <dd className="break-all">{result.email ?? t("noEmail")}</dd>
              <dt className={mutedCls}>{t("date")}</dt>
              <dd>{f.dateTime(new Date(result.createdAt), { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" })}</dd>
              <dt className={mutedCls}>{t("type")}</dt>
              <dd>{t(`kind.${result.kind}`)}</dd>
              <dt className={mutedCls}>{t("status")}</dt>
              <dd><span className={result.status === "created" ? pillAccentCls : pillCls}>{t(`statuses.${result.status}`)}</span></dd>
            </dl>
            <div className="flex flex-wrap gap-x-4">
              {result.issueUrl && (
                <a href={result.issueUrl} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
                  {t("issue")}
                </a>
              )}
              {result.screenshotUrl ? (
                <a href={result.screenshotUrl} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
                  {t("screenshot")}
                </a>
              ) : (
                <span className={`${mutedCls} inline-flex min-h-11 items-center`}>{t("noScreenshot")}</span>
              )}
            </div>
            {result.screenshotUrl && <p className={`${mutedCls} text-xs`}>{t("screenshotNote")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
