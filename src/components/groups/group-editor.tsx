"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField, TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnDanger, btnPrimary, btnSecondary } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import {
  MAX_ENTRIES_PER_GROUP,
  type ActionError,
  type TravelGroup,
  type TravelGroupInput,
} from "@/lib/domain";
import { createGroup, deleteGroup, updateGroup } from "@/lib/server/groups";
import { AgePreview } from "./age-preview";
import { draftToInput, emptyDraft, fromStored, type EntryDraft } from "./draft";
import { EntryEditor } from "./entry-editor";

type Props = { group?: TravelGroup; profileBirthdate: string | null };

export function GroupEditor({ group, profileBirthdate }: Props) {
  const t = useTranslations("groups");
  const router = useRouter();
  const [name, setName] = useState(group?.name ?? "");
  const [notes, setNotes] = useState(group?.notes ?? "");
  const [entries, setEntries] = useState<EntryDraft[]>(() =>
    (group?.entries ?? []).map(fromStored),
  );
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  const hasSelf = entries.some((e) => e.isSelf);
  const full = entries.length >= MAX_ENTRIES_PER_GROUP;

  const patch = (key: string, p: Partial<EntryDraft>) =>
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...p } : e)));
  const move = (index: number, dir: -1 | 1) =>
    setEntries((list) => {
      const next = [...list];
      [next[index], next[index + dir]] = [next[index + dir], next[index]];
      return next;
    });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    setSaved(false);
    const input: TravelGroupInput = { name, notes, entries: entries.map(draftToInput) };
    start(async () => {
      const result = group ? await updateGroup(group.id, input) : await createGroup(input);
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
        return;
      }
      if (group) {
        setEntries(result.data.entries.map(fromStored));
        setSaved(true);
        router.refresh();
      } else {
        router.push("/app/groups");
      }
    });
  }

  function onDelete() {
    if (!group) return;
    start(async () => {
      const result = await deleteGroup(group.id);
      if (result.ok) router.push("/app/groups");
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
        error={errorAt(issues, "name", t("entry.fieldInvalid"))}
      />
      <TextAreaField
        label={t("notes")}
        hint={t("notesHint")}
        value={notes}
        maxLength={2000}
        onChange={(e) => setNotes(e.target.value)}
        error={errorAt(issues, "notes", t("entry.fieldInvalid"))}
      />

      <section aria-labelledby="entries-title" className="flex flex-col gap-3">
        <h2 id="entries-title" className="text-lg font-semibold">
          {t("entriesTitle")}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("entriesHint")}</p>
        {entries.length > 0 && (
          <ol className="flex flex-col gap-3">
            {entries.map((draft, i) => (
              <EntryEditor
                key={draft.key}
                draft={draft}
                index={i}
                total={entries.length}
                issues={issues}
                onChange={(p) => patch(draft.key, p)}
                onMove={(dir) => move(i, dir)}
                onRemove={() => setEntries((list) => list.filter((e) => e.key !== draft.key))}
              />
            ))}
          </ol>
        )}
        {issues?.some((i) => i.path === "entries") && (
          <p className="text-sm text-red-700 dark:text-red-400">{t("entry.fieldInvalid")}</p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            className={btnSecondary}
            disabled={full}
            onClick={() => setEntries((l) => [...l, emptyDraft("composition")])}
          >
            {t("addComposition")}
          </button>
          <button
            type="button"
            className={btnSecondary}
            disabled={full}
            onClick={() => setEntries((l) => [...l, emptyDraft("member")])}
          >
            {t("addMember")}
          </button>
          <button
            type="button"
            className={btnSecondary}
            disabled={full || hasSelf}
            onClick={() => setEntries((l) => [...l, emptyDraft("member", true)])}
          >
            {t("addSelf")}
          </button>
        </div>
        {hasSelf && !profileBirthdate && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("selfNoBirthdate")}</p>
        )}
      </section>

      <AgePreview entries={entries} date={today} profileBirthdate={profileBirthdate} />

      <ErrorBanner error={error} />
      {saved && (
        <p role="status" className="text-sm text-green-800 dark:text-green-300">
          {t("saved")}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        {group ? (
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
        description={t("deleteBody", { name: group?.name ?? "" })}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        pending={pending}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </form>
  );
}
