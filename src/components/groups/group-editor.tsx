"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField, TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnDanger, btnPrimary, btnSecondary, mutedCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import {
  MAX_ENTRIES_PER_GROUP,
  TRAIT_KEYS,
  type TraitKey,
  type ActionError,
  type GroupParse,
  type TravelGroup,
  type TravelGroupInput,
} from "@/lib/domain";
import { createGroup, deleteGroup, updateGroup } from "@/lib/server/groups";
import { AgePreview } from "./age-preview";
import { draftToInput, emptyDraft, fromStored, hasTraitValue, parseToDrafts, type EntryDraft } from "./draft";
import { GroupTextField } from "./group-text-field";
import { EntryEditor } from "./entry-editor";

/** Stored entries as drafts, "me" always first, otherwise in order of adding. */
function selfFirst(stored: TravelGroup["entries"]): EntryDraft[] {
  const drafts = stored.map(fromStored);
  return [...drafts.filter((d) => d.isSelf), ...drafts.filter((d) => !d.isSelf)];
}

type Props = { group?: TravelGroup; profileBirthdate: string | null };

export function GroupEditor({ group, profileBirthdate }: Props) {
  const t = useTranslations("groups");
  const router = useRouter();
  const [name, setName] = useState(group?.name ?? "");
  const [notes, setNotes] = useState(group?.notes ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  // What the server has saved: the text the parse belongs to, and that parse.
  const [savedText, setSavedText] = useState<{ text?: string; parse?: GroupParse }>({
    text: group?.description,
    parse: group?.parse,
  });
  const [detailsOpen, setDetailsOpen] = useState(() => (group?.entries.length ?? 0) > 0 || !!group?.notes);
  const [traitKeys, setTraitKeys] = useState<TraitKey[]>(() => group?.traitKeys ?? []);
  const [entries, setEntries] = useState<EntryDraft[]>(() => selfFirst(group?.entries ?? []));
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  const hasSelf = entries.some((e) => e.isSelf);
  const full = entries.length >= MAX_ENTRIES_PER_GROUP;

  const canAccept = entries.every((e) => e.kind === "composition");
  function adjustFromParse(parse: GroupParse) {
    setEntries(
      parseToDrafts(parse, {
        today,
        profileBirthdate,
        roleLabel: (role) => t(`text.roles.${role}`),
      }),
    );
    setDetailsOpen(true);
    // The structured section is below; bring it into view once it is open.
    setTimeout(() => document.getElementById("exact-details")?.scrollIntoView({ block: "start" }), 0);
  }

  const patch = (key: string, p: Partial<EntryDraft>) =>
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...p } : e)));
  const toggleTrait = (key: TraitKey) =>
    setTraitKeys((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));
  const addEntry = (draft: EntryDraft) =>
    setEntries((l) => (draft.isSelf ? [draft, ...l] : [...l, draft]));
  const droppedTraits = TRAIT_KEYS.filter(
    (k) => !traitKeys.includes(k) && entries.some((e) => hasTraitValue(e, k)),
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    setSaved(false);
    const input: TravelGroupInput = {
      name,
      notes,
      description,
      traitKeys,
      entries: entries.map((e) => draftToInput(e, traitKeys)),
    };
    start(async () => {
      const result = group ? await updateGroup(group.id, input) : await createGroup(input);
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
        if (result.issues?.some((i) => /^(notes|traitKeys|entries)/.test(i.path))) setDetailsOpen(true);
        return;
      }
      if (group) {
        setEntries(selfFirst(result.data.entries));
        setTraitKeys(result.data.traitKeys);
        setSavedText({ text: result.data.description, parse: result.data.parse });
        setSaved(true);
        router.refresh();
      } else if (result.data.description) {
        // Stay on the group so the recognised result ("Recognised: ...") is visible right away.
        router.replace(`/app/groups/${result.data.id}`);
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
      <GroupTextField
        label={t("text.label")}
        hint={t("text.hint")}
        value={description}
        onChange={setDescription}
        error={errorAt(issues, "description", t("entry.fieldInvalid"))}
        saved={savedText}
        hasStructure={entries.length > 0}
        canAccept={canAccept}
        onAdjust={adjustFromParse}
        date={today}
        profileBirthdate={profileBirthdate}
      />

      <details
        id="exact-details"
        open={detailsOpen}
        onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
        className="rounded-lg border border-neutral-300 p-4 dark:border-neutral-700"
      >
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold focus-visible:outline-2 focus-visible:outline-blue-600">
          {t("exact.title")}
        </summary>
        <div className="mt-2 flex flex-col gap-6">
          <p className={`text-sm ${mutedCls}`}>{t("exact.hint")}</p>
          <TextAreaField
            label={t("notes")}
            hint={t("notesHint")}
            value={notes}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
            error={errorAt(issues, "notes", t("entry.fieldInvalid"))}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-lg font-semibold">{t("traits.title")}</legend>
            <p className={`text-sm ${mutedCls}`}>{t("traits.hint")}</p>
            <div className="flex flex-wrap gap-2">
              {TRAIT_KEYS.map((key) => {
                const on = traitKeys.includes(key);
                return (
                  <label
                    key={key}
                    className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium focus-within:outline-2 focus-within:outline-blue-600 ${
                      on
                        ? "border-blue-700 bg-blue-50 dark:border-blue-400 dark:bg-blue-950"
                        : "border-neutral-400 hover:bg-neutral-100 dark:border-neutral-500 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={on}
                      onChange={() => toggleTrait(key)}
                    />
                    {t(`traits.options.${key}`)}
                  </label>
                );
              })}
            </div>
            {droppedTraits.length > 0 && (
              <p role="status" className="text-sm text-amber-800 dark:text-amber-300">
                {t("traits.willBeRemoved", {
                  traits: droppedTraits.map((k) => t(`traits.options.${k}`)).join(", "),
                })}
              </p>
            )}
          </fieldset>

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
                    traitKeys={traitKeys}
                    issues={issues}
                    onChange={(p) => patch(draft.key, p)}
                    onRemove={() => setEntries((list) => list.filter((e) => e.key !== draft.key))}
                  />
                ))}
              </ol>
            )}
            {issues?.some((i) => i.path === "entries") && (
              <p className="text-sm text-red-700 dark:text-red-400">{t("entry.fieldInvalid")}</p>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={full}
                  aria-describedby="add-composition-help"
                  onClick={() => addEntry(emptyDraft("composition"))}
                >
                  {t("addComposition")}
                </button>
                <p id="add-composition-help" className={`text-sm ${mutedCls}`}>
                  {t("addCompositionHelp")}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={full}
                  aria-describedby="add-member-help"
                  onClick={() => addEntry(emptyDraft("member"))}
                >
                  {t("addMember")}
                </button>
                <p id="add-member-help" className={`text-sm ${mutedCls}`}>
                  {t("addMemberHelp")}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={full || hasSelf}
                  aria-describedby="add-self-help"
                  onClick={() => addEntry(emptyDraft("member", true))}
                >
                  {t("addSelf")}
                </button>
                <p id="add-self-help" className={`text-sm ${mutedCls}`}>
                  {t("addSelfHelp")}
                </p>
              </div>
            </div>
            {hasSelf && !profileBirthdate && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("selfNoBirthdate")}</p>
            )}
          </section>

          <AgePreview entries={entries} date={today} profileBirthdate={profileBirthdate} />
        </div>
      </details>

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
