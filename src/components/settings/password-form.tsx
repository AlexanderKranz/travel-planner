"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TextField } from "@/components/ui/fields";
import { btnPrimary, cardCls, mutedCls } from "@/components/ui/styles";
import { PASSWORD_MAX, PASSWORD_MIN, SetPasswordInput, passwordBytes } from "@/lib/domain/auth";
import type { ActionError } from "@/lib/domain";
import { setPassword } from "@/lib/server/auth/actions";

/** Optional password for email + password login. Not rendered for the demo account (the action refuses it too). */
export function PasswordForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const t = useTranslations("settings.password");
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [fieldError, setFieldError] = useState<"short" | "bytes" | "mismatch" | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const parsed = SetPasswordInput.safeParse({ password, confirm });
    if (!parsed.success) {
      setFieldError(
        password.length < PASSWORD_MIN ? "short" : passwordBytes(password) > PASSWORD_MAX ? "bytes" : "mismatch",
      );
      return;
    }
    setFieldError(null);
    start(async () => {
      const result = await setPassword({ password, confirm });
      if (result.ok) {
        setSaved(true);
        setPasswordValue("");
        setConfirm("");
      } else setError(result.error);
    });
  }

  return (
    <section id="password" aria-labelledby="password-title" className={`${cardCls} flex flex-col gap-3`}>
      <h2 id="password-title" className="font-serif text-xl font-bold">
        {t("title")}
      </h2>
      <p className={`text-sm ${mutedCls}`}>{t("hint")}</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label={t("newLabel")}
          hint={t("rules", { min: PASSWORD_MIN, max: PASSWORD_MAX })}
          type="password"
          name="new-password"
          value={password}
          onChange={(e) => setPasswordValue(e.target.value)}
          autoComplete="new-password"
          autoFocus={autoFocus}
          minLength={PASSWORD_MIN}
          required
          error={
            fieldError === "short"
              ? t("tooShort", { min: PASSWORD_MIN })
              : fieldError === "bytes"
                ? t("tooManyBytes", { max: PASSWORD_MAX })
                : undefined
          }
        />
        <TextField
          label={t("confirmLabel")}
          type="password"
          name="confirm-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          error={fieldError === "mismatch" ? t("mismatch") : undefined}
        />
        <ErrorBanner error={error} />
        {saved && (
          <p role="status" className="text-sm">
            {t("saved")}
          </p>
        )}
        <div>
          <button type="submit" className={btnPrimary} disabled={pending}>
            {t("save")}
          </button>
        </div>
      </form>
    </section>
  );
}
