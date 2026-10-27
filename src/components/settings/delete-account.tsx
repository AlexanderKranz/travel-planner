"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TextField } from "@/components/ui/fields";
import { btnDanger, cardCls, mutedCls } from "@/components/ui/styles";
import type { ActionError } from "@/lib/domain";
import { deleteAccount } from "@/lib/server/account";

export function DeleteAccount() {
  const t = useTranslations("settings.delete");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  function onConfirm() {
    setError(null);
    start(async () => {
      const result = await deleteAccount(locale);
      if (result && !result.ok) {
        setOpen(false);
        setError(result.error);
      }
    });
  }

  return (
    <section
      aria-labelledby="delete-title"
      className={`${cardCls} flex flex-col gap-3 border-red-600 dark:border-red-400`}
    >
      <h2 id="delete-title" className="font-semibold">
        {t("title")}
      </h2>
      <p className={`text-sm ${mutedCls}`}>{t("body")}</p>
      <ErrorBanner error={error} />
      <div>
        <button type="button" className={btnDanger} onClick={() => setOpen(true)}>
          {t("button")}
        </button>
      </div>
      <ConfirmDialog
        open={open}
        title={t("dialogTitle")}
        description={t("dialogBody")}
        confirmLabel={t("confirm")}
        cancelLabel={t("cancel")}
        confirmDisabled={word.trim() !== t("word")}
        pending={pending}
        onConfirm={onConfirm}
        onCancel={() => {
          setOpen(false);
          setWord("");
        }}
      >
        <TextField
          label={t("wordLabel", { word: t("word") })}
          value={word}
          onChange={(e) => setWord(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
        />
      </ConfirmDialog>
    </section>
  );
}
