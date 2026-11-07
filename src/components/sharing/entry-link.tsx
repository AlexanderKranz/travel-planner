"use client";

import { useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { btnSecondary } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { claimGroupEntry, unclaimGroupEntry } from "@/lib/server/group-links";
import type { EntryLinkView } from "./entry-link-view";
import { shareErrorKey } from "./helpers";

/**
 * "That's me", "That's not me" or the owner's "Remove link" for one entry (docs/specs/group-sharing.md 4.2). Full width
 * under the entry on a phone, at least 44 px high. After `already_*` the group is reloaded: somebody else was faster, or the
 * viewer had already marked another entry in another tab, so what is offered has changed.
 */
export function EntryLinkAction({
  entryId,
  action,
  linkedName,
  describedBy,
}: {
  entryId: string;
  action: NonNullable<EntryLinkView["action"]>;
  /** For "Remove link": the name in the confirmation and the accessible name (linked person, else the typed name). */
  linkedName: string;
  /** Id of the element naming the entry, so the plain button text has context for screen readers. */
  describedBy?: string;
}) {
  const t = useTranslations("sharing");
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  function run() {
    setError(null);
    start(async () => {
      const r = action === "claim" ? await claimGroupEntry({ entryId }) : await unclaimGroupEntry({ entryId });
      setOpen(false);
      if (r.ok) {
        router.refresh();
        return;
      }
      setError(r.error);
      if (r.error === "already_linked" || r.error === "already_claimed") router.refresh();
    });
  }

  const label = action === "claim" ? t("link.thatsMe") : action === "unclaim" ? t("link.notMe") : t("link.remove");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        className={`${btnSecondary} w-full sm:w-auto`}
        disabled={pending}
        aria-describedby={describedBy}
        aria-label={action === "remove" ? t("link.removeFor", { name: linkedName }) : undefined}
        onClick={action === "remove" ? () => setOpen(true) : run}
      >
        {label}
      </button>
      {error && (
        <p id={`${uid}-err`} role="alert" className="text-sm text-danger-fg">
          {t(`errors.${shareErrorKey(error)}`, { max: 0 })}
        </p>
      )}
      {open && (
        <ConfirmDialog
          open
          title={t("link.remove")}
          description={t("link.confirmRemove", { name: linkedName })}
          confirmLabel={t("link.remove")}
          cancelLabel={t("cancel")}
          pending={pending}
          onConfirm={run}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The mark next to a typed name: "{name} ✓" for the owner, "✓ Linked" for everyone else. Text, not colour only. */
export function EntryMark({ mark }: { mark: NonNullable<EntryLinkView["mark"]> }) {
  const t = useTranslations("sharing");
  return (
    <span className="inline-flex items-center rounded-full border border-ok-line bg-ok-bg px-2.5 py-0.5 text-xs font-medium text-ok-fg">
      {mark.kind === "person" ? t("link.linkedTo", { name: mark.name }) : t("link.linked")}
    </span>
  );
}

/**
 * Mark and button of one entry, per viewer: "You" on the viewer's own entry, "{name} ✓" / "✓ Linked" on others, then the
 * button. Stacks on a phone so the button gets the full width under the name.
 */
export function EntryLinkLine({
  entryId,
  view,
  typedName,
  nameId,
  showYou = true,
}: {
  entryId: string;
  view: EntryLinkView;
  typedName: string;
  nameId?: string;
  /** False where the entry's label already says "You". */
  showYou?: boolean;
}) {
  const t = useTranslations("sharing");
  const hasYou = showYou && view.who === "you" && view.action === "unclaim";
  if (!hasYou && !view.mark && !view.action) return null;
  const linkedName = view.mark?.kind === "person" ? view.mark.name : typedName;
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" data-testid="entry-link">
      {hasYou && (
        <span className="inline-flex items-center self-start rounded-full border border-ok-line bg-ok-bg px-2.5 py-0.5 text-xs font-medium text-ok-fg">
          {t("link.you")}
        </span>
      )}
      {view.mark && <EntryMark mark={view.mark} />}
      {view.action && <EntryLinkAction entryId={entryId} action={view.action} linkedName={linkedName} describedBy={nameId} />}
    </div>
  );
}
