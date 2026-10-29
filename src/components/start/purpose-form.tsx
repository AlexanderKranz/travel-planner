"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TextAreaField, TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnPrimary } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { createPurpose } from "@/lib/server/purposes";

/** Step 3: name + free text. Guided fields and chips live in the full purpose editor. */
export function PurposeForm() {
  const t = useTranslations("start.purpose");
  const ts = useTranslations("settings");
  const router = useRouter();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    start(async () => {
      const result = await createPurpose({ name, text });
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
        return;
      }
      setCreatedName(result.data.name);
      setName("");
      setText("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t("name")}
        placeholder={t("namePlaceholder")}
        value={name}
        maxLength={80}
        required
        onChange={(e) => setName(e.target.value)}
        error={errorAt(issues, "name", ts("fieldInvalid"))}
      />
      <TextAreaField
        label={t("text")}
        hint={t("textHint")}
        value={text}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        error={errorAt(issues, "text", ts("fieldInvalid"))}
      />
      <ErrorBanner error={error} />
      {createdName && (
        <p role="status" className="text-sm text-ok">
          {t("done", { name: createdName })}
        </p>
      )}
      <div>
        <button type="submit" className={btnPrimary} disabled={pending || name.trim() === ""}>
          {createdName ? t("another") : t("save")}
        </button>
      </div>
    </form>
  );
}
