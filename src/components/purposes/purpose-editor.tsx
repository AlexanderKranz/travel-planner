"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TextAreaField, TextField } from "@/components/ui/fields";
import { errorAt, hasIssue, type Issue } from "@/components/ui/issues";
import { btnDanger, btnPrimary } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import { MAX_CONSTRAINTS, type ActionError, type TripPurpose } from "@/lib/domain";
import { createPurpose, deletePurpose, updatePurpose } from "@/lib/server/purposes";
import { ChipList } from "./chip-list";
import {
  emptyGuided,
  GuidedFields,
  guidedFromStored,
  guidedToInput,
  type GuidedState,
} from "./guided-fields";

export function PurposeEditor({ purpose }: { purpose?: TripPurpose }) {
  const t = useTranslations("purposes");
  const router = useRouter();
  const [name, setName] = useState(purpose?.name ?? "");
  const [text, setText] = useState(purpose?.text ?? "");
  const [guided, setGuided] = useState<GuidedState>(
    purpose ? guidedFromStored(purpose.guided) : emptyGuided,
  );
  const [constraints, setConstraints] = useState<string[]>(purpose?.constraints ?? []);
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const bad = t("fieldInvalid");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    setSaved(false);
    const input = { name, text, guided: guidedToInput(guided), constraints };
    start(async () => {
      const result = purpose
        ? await updatePurpose(purpose.id, input)
        : await createPurpose(input);
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
      } else if (purpose) {
        setSaved(true);
        router.refresh();
      } else {
        router.push("/app/purposes");
      }
    });
  }

  function onDelete() {
    if (!purpose) return;
    start(async () => {
      const result = await deletePurpose(purpose.id);
      if (result.ok) router.push("/app/purposes");
      else {
        setConfirmDelete(false);
        setError(result.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <TextField
        label={t("name")}
        value={name}
        maxLength={80}
        required
        onChange={(e) => setName(e.target.value)}
        error={errorAt(issues, "name", bad)}
      />
      <TextAreaField
        label={t("text")}
        hint={t("textHint")}
        rows={5}
        value={text}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        error={errorAt(issues, "text", bad)}
      />

      <details className="rounded-lg border border-neutral-300 p-4 dark:border-neutral-700" open={!!purpose && Object.keys(purpose.guided).length > 1}>
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold focus-visible:outline-2 focus-visible:outline-blue-600">
          {t("guidedTitle")}
        </summary>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">{t("guidedHint")}</p>
        <GuidedFields value={guided} onChange={setGuided} invalid={hasIssue(issues, "guided")} />
      </details>

      <section aria-labelledby="constraints-title" className="flex flex-col gap-2">
        <h2 id="constraints-title" className="font-semibold">
          {t("constraints")}
        </h2>
        <ChipList
          label={t("constraintLabel")}
          hint={t("constraintsHint")}
          addLabel={t("add")}
          items={constraints}
          max={MAX_CONSTRAINTS}
          maxLength={200}
          asList
          error={errorAt(issues, "constraints", bad)}
          onChange={setConstraints}
        />
      </section>

      <ErrorBanner error={error} />
      {saved && (
        <p role="status" className="text-sm text-green-800 dark:text-green-300">
          {t("saved")}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        {purpose ? (
          <button type="button" className={btnDanger} onClick={() => setConfirmDelete(true)}>
            {t("delete")}
          </button>
        ) : (
          <span />
        )}
        <button type="submit" className={btnPrimary} disabled={pending}>
          {t("save")}
        </button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t("deleteTitle")}
        description={t("deleteBody", { name: purpose?.name ?? "" })}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        pending={pending}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </form>
  );
}
