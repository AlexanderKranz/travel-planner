"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { TextField } from "@/components/ui/fields";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnPrimary, btnSecondary, mutedCls } from "@/components/ui/styles";
import { requestLogin, verifyLoginCode } from "@/lib/server/auth/actions";
import type { ActionError } from "@/lib/domain";

export function LoginForm({ linkInvalid }: { linkInvalid: boolean }) {
  const t = useTranslations("login");
  const locale = useLocale();
  const [step, setStep] = useState<"email" | "sent">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  function onRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const result = await requestLogin({ email, locale });
      if (result.ok) setStep("sent");
      else setError(result.error);
    });
  }

  function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const result = await verifyLoginCode({ email, code, locale });
      if (result && !result.ok) setError(result.error);
    });
  }

  if (step === "sent") {
    return (
      <div className="flex flex-col gap-5">
        <div role="status" className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t("sentTitle")}</h2>
          <p className={mutedCls}>{t("sentBody")}</p>
        </div>
        <form onSubmit={onVerify} className="flex flex-col gap-4">
          <TextField
            label={t("codeLabel")}
            hint={t("codeHint")}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            error={error === "invalid" ? t("codeInvalid") : undefined}
          />
          {error && error !== "invalid" && <ErrorBanner error={error} />}
          <button type="submit" className={btnPrimary} disabled={pending || code.length !== 6}>
            {t("verify")}
          </button>
        </form>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => {
            setStep("email");
            setCode("");
            setError(null);
          }}
        >
          {t("back")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onRequest} className="flex flex-col gap-4">
      {linkInvalid && (
        <p
          role="alert"
          className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg"
        >
          {t("linkInvalid")}
        </p>
      )}
      <TextField
        label={t("emailLabel")}
        type="email"
        name="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        required
        error={error === "invalid" ? t("emailInvalid") : undefined}
      />
      {error && error !== "invalid" && <ErrorBanner error={error} />}
      <button type="submit" className={btnPrimary} disabled={pending}>
        {t("submit")}
      </button>
      <p className={`text-sm ${mutedCls}`}>{t("inviteOnly")}</p>
    </form>
  );
}
