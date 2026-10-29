"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TextAreaField, TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnPrimary } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import { GROUP_TEXT_MAX, type ActionError } from "@/lib/domain";
import { createGroup } from "@/lib/server/groups";

/** Step 2: name + free-text description. The server parses the text on save, exactly like the group editor. */
export function GroupForm() {
  const t = useTranslations("start.group");
  const ts = useTranslations("settings");
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    start(async () => {
      const result = await createGroup({ name, description, entries: [], traitKeys: [] });
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
        return;
      }
      setCreatedName(result.data.name);
      setName("");
      setDescription("");
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
        label={t("description")}
        hint={t("descriptionHint")}
        value={description}
        maxLength={GROUP_TEXT_MAX}
        onChange={(e) => setDescription(e.target.value)}
        error={errorAt(issues, "description", ts("fieldInvalid"))}
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
