"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { TextField } from "@/components/ui/fields";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnPrimary, btnSecondary, linkCls, mutedCls } from "@/components/ui/styles";
import {
  requestLogin,
  requestPasswordReset,
  signInWithPasswordAction,
  verifyLoginCode,
} from "@/lib/server/auth/actions";
import type { ActionError } from "@/lib/domain";

export function LoginForm({ linkInvalid, invited = false }: { linkInvalid: boolean; invited?: boolean }) {
  const t = useTranslations("login");
  const locale = useLocale();
  const [step, setStep] = useState<"email" | "sent" | "password" | "forgot" | "reset_sent">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  function onPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const result = await signInWithPasswordAction({ email, password, locale });
      if (result && !result.ok) setError(result.error);
    });
  }

  function onForgot(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const result = await requestPasswordReset({ email, locale });
      if (result.ok) setStep("reset_sent");
      else setError(result.error);
    });
  }

  function switchMode(next: "email" | "password" | "forgot") {
    setStep(next);
    setPassword("");
    setError(null);
  }

  if (step === "reset_sent") {
    return (
      <div className="flex flex-col gap-5">
        <div role="status" className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t("sentTitle")}</h2>
          <p className={mutedCls}>{t("password.resetSentBody")}</p>
        </div>
        <button type="button" className={btnSecondary} onClick={() => switchMode("password")}>
          {t("password.backToPassword")}
        </button>
      </div>
    );
  }

  if (step === "password" || step === "forgot") {
    const forgot = step === "forgot";
    return (
      <form onSubmit={forgot ? onForgot : onPassword} className="flex flex-col gap-4">
        {forgot && <p className={`text-sm ${mutedCls}`}>{t("password.forgotIntro")}</p>}
        <TextField
          label={t("emailLabel")}
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          error={forgot && error === "invalid" ? t("emailInvalid") : undefined}
        />
        {!forgot && (
          <TextField
            label={t("password.label")}
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        )}
        {error && !(forgot && error === "invalid") && <ErrorBanner error={error} />}
        <button type="submit" className={btnPrimary} disabled={pending}>
          {forgot ? t("password.forgotSubmit") : t("password.submit")}
        </button>
        {!forgot && (
          <button type="button" className={`${linkCls} min-h-11 self-start`} onClick={() => switchMode("forgot")}>
            {t("password.forgot")}
          </button>
        )}
        <button type="button" className={`${linkCls} min-h-11 self-start`} onClick={() => switchMode("email")}>
          {t("password.useLink")}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onRequest} className="flex flex-col gap-4">
      {invited && !linkInvalid && (
        <p role="status" className="rounded-lg border border-line bg-sunken p-3 text-sm text-ink">
          {t("invited")}
        </p>
      )}
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
      <button type="button" className={`${linkCls} min-h-11 self-start`} onClick={() => switchMode("password")}>
        {t("password.usePassword")}
      </button>
      <p className={`text-sm ${mutedCls}`}>{t("inviteOnly")}</p>
    </form>
  );
}
