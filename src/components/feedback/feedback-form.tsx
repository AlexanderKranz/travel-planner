"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { TextAreaField } from "@/components/ui/fields";
import { btnPrimary, btnSecondary, cardCls, mutedCls } from "@/components/ui/styles";
import { FEEDBACK_TEXT_MAX, FEEDBACK_TEXT_MIN, type FeedbackKind, type FeedbackResponse, type FeedbackScreenshotState } from "@/lib/domain/feedback";
import { SCREENSHOT_ACCEPT, buildFeedbackFormData, checkScreenshotInput, responseErrorKey, textState } from "@/lib/feedback-client";
import { downscaleScreenshot } from "./downscale";

type Done = { ref: string; screenshot: FeedbackScreenshotState };

export function FeedbackForm({ initialKind, from }: { initialKind: FeedbackKind; from?: string }) {
  const t = useTranslations("feedback");
  const router = useRouter();
  const kindName = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<FeedbackKind>(initialKind);
  const [text, setText] = useState("");
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [touched, setTouched] = useState(false);
  const inFlight = useRef(false);
  const focusText = useRef(false);

  const urlRef = useRef<string | null>(null);
  const setFile = (blob: Blob | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = blob ? URL.createObjectURL(blob) : null;
    setShot(blob && urlRef.current ? { blob, url: urlRef.current } : null);
  };
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  useEffect(() => {
    if (done) resultRef.current?.focus();
    else if (focusText.current) {
      focusText.current = false;
      document.getElementById("feedback-text")?.focus();
    }
  }, [done]);

  const state = textState(text);
  const count = text.trim().length;
  const textProblem = !touched ? undefined : state === "short" || state === "empty" ? t("form.tooShort", { min: FEEDBACK_TEXT_MIN }) : state === "long" ? t("form.tooLong", { max: FEEDBACK_TEXT_MAX }) : undefined;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = "";
    setFileError(null);
    if (!picked) return;
    const check = checkScreenshotInput(picked);
    if (check !== "ok") return setFileError(t(check === "bad_type" ? "errors.badImage" : "errors.tooLarge"));
    setBusy(true);
    const r = await downscaleScreenshot(picked);
    setBusy(false);
    if (!r.ok) return setFileError(t(r.reason === "too_large" ? "errors.tooLarge" : "errors.badImage"));
    setFile(r.blob);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || busy) return;
    if (state !== "ok") {
      setTouched(true);
      document.getElementById("feedback-text")?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = buildFeedbackFormData({ kind, text, from, viewport: window.innerWidth, screenshot: shot?.blob });
      const res = await fetch("/api/feedback", { method: "POST", body });
      const json = (await res.json().catch(() => null)) as FeedbackResponse | null;
      if (json?.ok) {
        setDone({ ref: json.ref, screenshot: json.screenshot });
        setText("");
        setFile(null);
        router.refresh(); // the new row shows up in "my reports"
      } else {
        setError(responseErrorKey(res.status, json, res.headers.get("Retry-After")));
      }
    } catch {
      setError("failed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className={`${cardCls} flex flex-col gap-3 focus:outline-none`}>
        <h2 className="font-serif text-xl font-bold text-heading">{t("success.title")}</h2>
        <p>
          {t("success.ref")} <code className="font-semibold">{done.ref}</code>
        </p>
        <p className={`text-sm ${mutedCls}`}>{t("success.hint")}</p>
        {done.screenshot === "failed" && <p className="text-sm text-warn-fg">{t("success.screenshotFailed")}</p>}
        <button type="button" className={`${btnSecondary} self-start`} onClick={() => { focusText.current = true; setTouched(false); setDone(null); }}>
          {t("success.another")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t("form.kind")}</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(["bug", "idea"] as const).map((k) => (
            <label
              key={k}
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                kind === k ? "border-heading bg-sunken" : "border-line-strong bg-card"
              }`}
            >
              <input type="radio" name={kindName} value={k} checked={kind === k} onChange={() => setKind(k)} className="mt-1 size-5 accent-accent" />
              <span>
                <span className="block font-semibold">{t(`kinds.${k}`)}</span>
                <span className={`block text-sm ${mutedCls}`}>{t(`kinds.${k}Hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <TextAreaField
          label={t("form.text")}
          hint={t("form.textHint", { min: FEEDBACK_TEXT_MIN })}
          error={textProblem}
          id="feedback-text"
          value={text}
          onBlur={() => setTouched(true)}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          required
          maxLength={FEEDBACK_TEXT_MAX + 500}
          placeholder={t(kind === "bug" ? "form.placeholderBug" : "form.placeholderIdea")}
        />
        <p className={`mt-1 text-right text-xs tabular-nums ${count > FEEDBACK_TEXT_MAX ? "text-danger" : mutedCls}`}>
          {t("form.counter", { count, max: FEEDBACK_TEXT_MAX })}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="feedback-shot" className="text-sm font-medium">
          {t("form.screenshot")}
        </label>
        <input
          ref={fileRef}
          id="feedback-shot"
          type="file"
          accept={SCREENSHOT_ACCEPT}
          onChange={onPick}
          disabled={busy}
          aria-describedby="feedback-shot-hint"
          className="block min-h-11 w-full text-sm file:mr-3 file:min-h-11 file:rounded-lg file:border-[1.5px] file:border-heading file:bg-transparent file:px-4 file:font-semibold file:text-heading"
        />
        <p id="feedback-shot-hint" className={`text-sm ${mutedCls}`}>
          {t("form.screenshotHint")}
        </p>
        {fileError && (
          <p role="alert" className="text-sm text-danger">
            {fileError}
          </p>
        )}
        {shot && (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
            <img src={shot.url} alt={t("form.previewAlt")} className="max-h-32 max-w-[60%] rounded-lg border border-line object-contain" />
            <button type="button" className={btnSecondary} onClick={() => setFile(null)}>
              {t("form.removeScreenshot")}
            </button>
          </div>
        )}
      </div>

      <div aria-live="polite">
        {error && (
          <p role="alert" className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
            {t(`errors.${error}`, { min: FEEDBACK_TEXT_MIN, max: FEEDBACK_TEXT_MAX })}
          </p>
        )}
      </div>

      <button type="submit" className={`${btnPrimary} self-start`} disabled={busy}>
        {busy ? t("form.sending") : t("form.submit")}
      </button>
    </form>
  );
}
